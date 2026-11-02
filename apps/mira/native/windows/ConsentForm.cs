using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Homelab.Mira.Computer
{
    // Keep the native button's accessibility and keyboard behavior while making disabled text readable.
    internal sealed class ConsentActionButton : Button
    {
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            if (Enabled) return;
            Color background = MiraWindow.Raised;
            args.Graphics.Clear(background);
            using (var border = new Pen(MiraWindow.Border))
                args.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            TextRenderer.DrawText(args.Graphics, Text, Font, ClientRectangle,
                MiraWindow.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    internal sealed class ConsentForm : MiraWindow
    {
        private readonly ConsentRequest request;
        private readonly NativeWindows.DesktopState desktop;
        private readonly Rectangle primaryBounds;
        private bool WholeDesktop { get { return request.Scope == "desktop"; } }
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly double consentDeadline;
        private readonly double sessionDeadline;
        private readonly ListView windows = new ListView();
        private readonly Button allow = new ConsentActionButton();
        private readonly Button stop = new Button();
        private readonly CheckBox foreground = new CheckBox();
        private readonly Label status = new Label();
        private readonly Label selection = new Label();
        private readonly Label heading = new Label();
        private readonly Label detail = new Label();
        private readonly System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer();
        private readonly object stateLock = new object();
        private readonly HashSet<IntPtr> candidates = new HashSet<IntPtr>();
        private readonly HashSet<IntPtr> destroyed = new HashSet<IntPtr>();
        private readonly WindowEvent destroyedCallback;
        private readonly IntPtr destroyedHook;
        private NativeWindows.WindowIdentity selected;
        private int stopped;
        private int closeRequested;
        private bool announced;
        private long lastCheck;
        private readonly System.Threading.Timer watchdog;
        private System.Threading.Timer forcedExit;

        private delegate void WindowEvent(IntPtr hook, uint eventId, IntPtr window, int objectId, int childId, uint thread, uint time);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWinEventHook(uint minimum, uint maximum, IntPtr module, WindowEvent callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")]
        private static extern bool UnhookWinEvent(IntPtr hook);

        internal ConsentForm(ConsentRequest input)
        {
            request = input;
            desktop = NativeWindows.ReadyDesktop();
            primaryBounds = Screen.PrimaryScreen.Bounds;
            consentDeadline = Math.Max(0, (input.ConsentExpiresAt - DateTime.UtcNow).TotalMilliseconds);
            sessionDeadline = Math.Max(0, (input.ExpiresAt - DateTime.UtcNow).TotalMilliseconds);
            destroyedCallback = delegate(IntPtr hook, uint eventId, IntPtr window, int objectId, int childId, uint thread, uint time)
            {
                bool retire;
                lock (stateLock)
                {
                    if (objectId != 0 || childId != 0 || !candidates.Contains(window)) return;
                    destroyed.Add(window);
                    retire = selected != null && selected.Handle == window;
                }
                if (retire) Retire();
                else UpdateAllow();
            };
            destroyedHook = WholeDesktop ? IntPtr.Zero : SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, destroyedCallback, 0, 0, 2);
            if (!WholeDesktop && destroyedHook == IntPtr.Zero) throw new InvalidOperationException("Window lifetime monitoring is unavailable.");
            Text = "Mira · Computer access";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Segoe UI", 10);
            BackColor = Canvas;
            ForeColor = TextColor;
            Size = new Size(720, 590);
            MinimumSize = new Size(580, 480);
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 6 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            heading.AutoSize = true;
            heading.Text = "Allow Mira to " + (input.Mode == "view" ? "view " : "control ") + (WholeDesktop ? "your desktop" : "one window");
            heading.Font = new Font(Font.FontFamily, 16, FontStyle.Bold);
            heading.Margin = new Padding(0, 0, 0, 12);
            detail.AutoSize = true; detail.MaximumSize = new Size(640, 0); detail.ForeColor = Muted;
            detail.Text = input.Origin + (WholeDesktop
                ? "\nEverything visible on your primary display is shared, including other apps and notifications."
                : "\nChoose a window to share. Its contents, including tabs, may be visible to Mira.") +
                (input.KeepOpen ? " Access stays open between replies until you stop it, lock the PC or disconnect." : " Access ends with this run, within five minutes.");
            detail.Margin = new Padding(0, 0, 0, 16);
            windows.Dock = DockStyle.Fill;
            windows.View = View.Details;
            windows.FullRowSelect = true;
            windows.MultiSelect = false;
            windows.HideSelection = false;
            windows.BackColor = MiraWindow.Raised;
            windows.ForeColor = ForeColor;
            windows.BorderStyle = BorderStyle.None;
            windows.HeaderStyle = ColumnHeaderStyle.None;
            windows.Columns.Add("Window", 380);
            windows.Columns.Add("Application", 220);
            windows.Resize += delegate {
                int available = Math.Max(0, windows.ClientSize.Width - SystemInformation.VerticalScrollBarWidth);
                windows.Columns[0].Width = (int)(available * .68);
                windows.Columns[1].Width = available - windows.Columns[0].Width;
            };
            windows.SelectedIndexChanged += delegate { UpdateAllow(); };
            foreground.AutoSize = true;
            foreground.MaximumSize = new Size(640, 0);
            foreground.Text = WholeDesktop ? "Allow Mira to click and type across apps on my primary display." : "Allow Mira to bring this window forward while clicking or typing.";
            foreground.Visible = input.Mode == "control";
            foreground.Margin = new Padding(0, 14, 0, 10);
            foreground.CheckedChanged += delegate { UpdateAllow(); };
            status.AutoSize = true;
            status.Margin = new Padding(0, 8, 0, 14);
            var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
            allow.Text = input.Mode == "view" ? "Allow viewing" : "Allow control";
            allow.AutoSize = true;
            allow.Enabled = false;
            allow.Padding = new Padding(12, 5, 12, 5);
            allow.FlatStyle = FlatStyle.Flat;
            allow.BackColor = Accent; allow.ForeColor = Canvas; allow.FlatAppearance.BorderSize = 0;
            allow.Click += delegate { ApproveSelected(); };
            stop.Text = "Decline";
            stop.AutoSize = true;
            stop.Padding = new Padding(12, 5, 12, 5);
            stop.FlatStyle = FlatStyle.Flat;
            stop.BackColor = Raised; stop.FlatAppearance.BorderColor = Border;
            stop.Click += delegate { Retire(); };
            actions.Controls.Add(allow);
            actions.Controls.Add(stop);
            layout.Controls.Add(heading);
            layout.Controls.Add(detail);
            var choicePanel = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0), BackColor = Raised };
            selection.Dock = DockStyle.Fill; selection.Padding = new Padding(20);
            selection.ForeColor = TextColor; selection.Visible = WholeDesktop;
            selection.Text = "Entire desktop · primary display\n\nOther displays are not shared. Move a window onto the primary display to work with it.";
            windows.Visible = !WholeDesktop;
            choicePanel.Controls.Add(windows); choicePanel.Controls.Add(selection);
            layout.Controls.Add(choicePanel);
            layout.Controls.Add(foreground);
            layout.Controls.Add(status);
            layout.Controls.Add(actions);
            Content.Controls.Add(layout);
            Content.Resize += delegate {
                int width = Math.Max(120, Content.ClientSize.Width - 48);
                heading.MaximumSize = detail.MaximumSize = foreground.MaximumSize = status.MaximumSize = new Size(width, 0);
            };
            CancelButton = stop;
            FormClosing += delegate { Retire(); };
            Shown += delegate { if (stopped != 0) Retire(); else LoadWindows(); };
            monitor.Interval = 250;
            monitor.Tick += delegate { Tick(); };
            monitor.Start();
            SystemEvents.SessionSwitch += SessionChanged;
            SystemEvents.PowerModeChanged += PowerChanged;
            SystemEvents.DisplaySettingsChanged += DisplayChanged;
            watchdog = new System.Threading.Timer(delegate
            {
                double elapsed = clock.Elapsed.TotalMilliseconds;
                if (elapsed >= sessionDeadline ||
                    (Volatile.Read(ref announced) && elapsed - Interlocked.Read(ref lastCheck) > 5000))
                    Retire();
            }, null, 250, 250);
        }

        // Always query the current OS state; an earlier "ready" event is not a permit.
        internal void CheckReady()
        {
            lock (stateLock)
            {
                if (stopped != 0 || !announced || clock.Elapsed.TotalMilliseconds >= sessionDeadline)
                    throw new InvalidOperationException("Local computer access is stopped.");
                CheckDesktop();
                if (!WholeDesktop && (destroyed.Contains(selected.Handle) || !NativeWindows.SameWindow(selected, NativeWindows.Identity(selected.Handle))))
                    throw new InvalidOperationException("The selected window changed.");
                if (stopped != 0) throw new InvalidOperationException("Local computer access is stopped.");
                Interlocked.Exchange(ref lastCheck, (long)clock.Elapsed.TotalMilliseconds);
            }
        }

        internal void Retire()
        {
            if (Interlocked.Exchange(ref stopped, 1) == 0)
            {
                forcedExit = new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 2000, Timeout.Infinite);
                try { ConsentProtocol.Write(new { method = "consent/stopped", @params = new { } }); } catch (Exception) { }
            }
            if (!IsDisposed && IsHandleCreated && Interlocked.Exchange(ref closeRequested, 1) == 0)
            {
                try
                {
                    BeginInvoke((Action)Close);
                }
                catch (InvalidOperationException) { }
            }
        }

        private void CheckDesktop()
        {
            var current = NativeWindows.ReadyDesktop();
            if (current.SessionId != desktop.SessionId || current.ConnectedAt != desktop.ConnectedAt || (WholeDesktop && Screen.PrimaryScreen.Bounds != primaryBounds))
                throw new InvalidOperationException("The desktop connection changed.");
        }

        private void LoadWindows()
        {
            try
            {
                if (!WholeDesktop) foreach (var window in NativeWindows.Windows())
                {
                    candidates.Add(window.Handle);
                    var item = new ListViewItem(window.Title);
                    item.SubItems.Add(System.IO.Path.GetFileName(window.Executable));
                    item.Tag = window;
                    windows.Items.Add(item);
                }
                Tick();
            }
            catch (Exception) { Retire(); }
        }

        private void UpdateAllow()
        {
            allow.Enabled = stopped == 0 && !announced && (WholeDesktop || windows.SelectedItems.Count == 1) &&
                (request.Mode == "view" || foreground.Checked) &&
                clock.Elapsed.TotalMilliseconds < consentDeadline &&
                (WholeDesktop || !destroyed.Contains(((NativeWindows.WindowIdentity)windows.SelectedItems[0].Tag).Handle));
        }

        private void ApproveSelected()
        {
            try
            {
                lock (stateLock)
                {
                    if (!allow.Enabled || stopped != 0 || announced ||
                        clock.Elapsed.TotalMilliseconds >= consentDeadline || (!WholeDesktop && windows.SelectedItems.Count != 1))
                        throw new InvalidOperationException("Local consent is unavailable.");
                    CheckDesktop();
                    object target;
                    if (WholeDesktop) {
                        target = new { scope = "desktop", displayId = "primary", delivery = "foreground" };
                    } else {
                        var choice = (NativeWindows.WindowIdentity)windows.SelectedItems[0].Tag;
                        if (destroyed.Contains(choice.Handle) || !NativeWindows.SameWindow(choice, NativeWindows.Identity(choice.Handle)))
                            throw new InvalidOperationException("The selected window changed.");
                        selected = choice;
                        target = new { executable = choice.Executable, pid = choice.ProcessId, windowId = choice.Handle.ToInt64().ToString(CultureInfo.InvariantCulture), startedAt = choice.StartedAt.ToString(CultureInfo.InvariantCulture), delivery = "foreground" };
                    }
                    if (stopped != 0) throw new InvalidOperationException("Local consent was stopped.");
                    ConsentProtocol.Write(new { method = "consent/selected", @params = new { target = target } });
                    Interlocked.Exchange(ref lastCheck, (long)clock.Elapsed.TotalMilliseconds);
                    Volatile.Write(ref announced, true);
                }
                allow.Visible = false;
                windows.Visible = false;
                selection.Text = WholeDesktop
                    ? "Connected desktop · primary display\n\n" + (request.Mode == "view" ? "Mira can view all visible apps." : "Mira can view, click and type across apps.")
                    : "Connected window\n\n" + selected.Title + "\n" + System.IO.Path.GetFileName(selected.Executable) +
                        (request.Mode == "view" ? "\n\nMira can view this window." : "\n\nMira can view, click and type in this window.");
                selection.Visible = true; selection.BringToFront();
                foreground.Visible = false;
                heading.Text = "Computer access is active";
                detail.Text = request.Origin + (WholeDesktop ? "\nYour primary display is shared." : "\nOnly the selected window is shared.") + " You can stop access at any time.";
                status.ForeColor = Color.FromArgb(110, 231, 183);
                stop.Text = "Stop access";
                Tick();
            }
            catch (Exception) { Retire(); }
        }

        private void Tick()
        {
            try
            {
                if (stopped != 0) { Retire(); return; }
                CheckDesktop();
                double remaining = (!announced ? consentDeadline : sessionDeadline) - clock.Elapsed.TotalMilliseconds;
                if (remaining <= 0) { Retire(); return; }
                // UI refresh does not count as a parent liveness check.
                if (!WholeDesktop && selected != null && (destroyed.Contains(selected.Handle) || !NativeWindows.SameWindow(selected, NativeWindows.Identity(selected.Handle))))
                    throw new InvalidOperationException("The selected window changed.");
                int seconds = (int)Math.Ceiling(remaining / 1000);
                status.Text = announced
                    ? (request.KeepOpen ? "Access stays open between replies. Use Stop access to take over." : "Access allowed · " + seconds + " seconds remaining. Use Stop access to take over.")
                    : "This request expires in " + seconds + " seconds.";
                UpdateAllow();
            }
            catch (Exception) { Retire(); }
        }

        private void SessionChanged(object sender, SessionSwitchEventArgs args)
        {
            // Never restore authority after a lock/unlock or reconnect transition.
            Retire();
        }
        private void DisplayChanged(object sender, EventArgs args)
        {
            if (WholeDesktop) Retire();
        }
        private void PowerChanged(object sender, PowerModeChangedEventArgs args)
        {
            if (args.Mode == PowerModes.Suspend || args.Mode == PowerModes.Resume) Retire();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                monitor.Stop();
                monitor.Dispose();
                if (destroyedHook != IntPtr.Zero) UnhookWinEvent(destroyedHook);
                watchdog.Dispose();
                if (forcedExit != null) forcedExit.Dispose();
                SystemEvents.SessionSwitch -= SessionChanged;
                SystemEvents.PowerModeChanged -= PowerChanged;
                SystemEvents.DisplaySettingsChanged -= DisplayChanged;
            }
            base.Dispose(disposing);
        }
    }
}
