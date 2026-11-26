using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Homelab.Mira.Computer
{
    internal sealed class ConsentForm : MiraWindow
    {
        private readonly ConsentRequest request;
        private readonly NativeWindows.DesktopState desktop;
        private readonly Rectangle primaryBounds;
        private bool AllDisplays { get { return request.Scope == "displays"; } }
        private bool WholeDesktop { get { return AllDisplays || request.Scope == "desktop"; } }
        private readonly DisplayLayout displayLayout;
        private string DisplayLabel { get { return AllDisplays ? (displayLayout.Monitors.Length == 1 ? "your display" : "all " + displayLayout.Monitors.Length + " displays") : "your primary display"; } }
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly double consentDeadline;
        private readonly double sessionDeadline;
        private readonly List<NativeWindows.WindowIdentity> windows = new List<NativeWindows.WindowIdentity>();
        private readonly DesktopDialogView dialog;
        private ConsentRecoveryView recovery;
        private string ForegroundLabel { get { return request.Mode != "control" || AllDisplays ? "" : WholeDesktop
            ? "Allow Mira to click and type across apps on my primary display." : "Allow Mira to bring this window forward while clicking or typing."; } }
        private int lastPresented = -1;
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

        internal ConsentForm(ConsentRequest input, string directory)
        {
            request = input;
            desktop = NativeWindows.ReadyDesktop();
            primaryBounds = Screen.PrimaryScreen.Bounds;
            if (AllDisplays) displayLayout = DisplayLayout.Current();
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
                else lastPresented = -1;
            };
            destroyedHook = WholeDesktop ? IntPtr.Zero : SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, destroyedCallback, 0, 0, 2);
            if (!WholeDesktop && destroyedHook == IntPtr.Zero) throw new InvalidOperationException("Window lifetime monitoring is unavailable.");
            Text = "Homelab · Computer access";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Segoe UI", 10);
            ForeColor = TextColor;
            Size = WholeDesktop ? new Size(680, 470) : new Size(720, 590);
            MinimumSize = new Size(380, 360);
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            dialog = new DesktopDialogView(Path.Combine(directory, "WebView2.LocalUI"));
            dialog.Decision += LocalDecision;
            dialog.Unavailable += delegate {
                if (dialog.HasPresented || announced) { Retire(); return; }
                if (recovery != null || stopped != 0 || IsDisposed) return;
                dialog.Hide();
                recovery = new ConsentRecoveryView(!WholeDesktop, windows.Select(WindowLabel).ToArray(), ForegroundLabel,
                    request.Mode == "control", index => index >= 0 && index < windows.Count && !destroyed.Contains(windows[index].Handle), LocalDecision);
                Content.Controls.Add(recovery); recovery.BringToFront();
                lastPresented = -1; Tick();
            };
            Content.Controls.Add(dialog);
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
            if (current.SessionId != desktop.SessionId || current.ConnectedAt != desktop.ConnectedAt || (AllDisplays && DisplayLayout.Current().Identity != displayLayout.Identity) || (WholeDesktop && Screen.PrimaryScreen.Bounds != primaryBounds))
                throw new InvalidOperationException("The desktop connection changed.");
        }

        private void LoadWindows()
        {
            try
            {
                if (!WholeDesktop) foreach (var window in NativeWindows.Windows())
                {
                    candidates.Add(window.Handle);
                    windows.Add(window);
                }
                Tick();
            }
            catch (Exception) { Retire(); }
        }

        private void LocalDecision(string action)
        {
            if (action == "stop") { Retire(); return; }
            // The local document can select only an entry from this request's OS enumeration.
            string[] parts = action.Split(':');
            if (parts.Length != 3 || parts[0] != "allow" || (parts[2] != "yes" && parts[2] != "no")) return;
            if (request.Mode == "control" && !AllDisplays && parts[2] != "yes") return;
            NativeWindows.WindowIdentity picked = null;
            if (WholeDesktop) { if (parts[1] != "screen") return; }
            else {
                int index;
                if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out index) || index < 0 || index >= windows.Count) return;
                picked = windows[index];
            }
            try
            {
                lock (stateLock)
                {
                    if (stopped != 0 || announced || clock.Elapsed.TotalMilliseconds >= consentDeadline) return;
                    CheckDesktop();
                    object target;
                    if (AllDisplays) {
                        target = new { scope = "displays", layout = displayLayout.Identity, delivery = "foreground" };
                    } else if (WholeDesktop) {
                        target = new { scope = "desktop", displayId = "primary", delivery = "foreground" };
                    } else {
                        var choice = picked;
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
                lastPresented = -1;
                Text = "Homelab · " + (WholeDesktop ? "Sharing " + DisplayLabel : "Sharing one window");
                Tick();
            }
            catch (Exception) { Retire(); }
        }

        private static string WindowLabel(NativeWindows.WindowIdentity window)
        {
            return window.Title + " · " + Path.GetFileName(window.Executable);
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
                if (lastPresented == seconds) return;
                lastPresented = seconds;
                bool control = request.Mode == "control";
                string title = announced
                    ? (WholeDesktop ? (control ? "Mira can control " : "Mira is viewing ") + DisplayLabel : "Computer access is active")
                    : "Allow Mira to " + (control ? "control " : "view ") + (WholeDesktop ? DisplayLabel : "one window") + "?";
                string detail = announced
                    ? (WholeDesktop ? "Visible apps and notifications are shared." : "Only the selected window is shared.")
                    : (WholeDesktop ? "Everything visible on " + DisplayLabel + " is shared, including other apps and notifications." +
                          (AllDisplays && control ? " Allow control lets Mira click and type across these displays." : "")
                      : "Choose a window to share. Its contents, including tabs, may be visible to Mira.") +
                      (request.KeepOpen ? " Access stays open between replies until you stop it, lock the PC or disconnect." : " Access ends with this run, within five minutes.");
                string status = announced
                    ? (request.KeepOpen ? "Access stays open between replies. Use Stop access to take over." : "Access allowed · " + seconds + " seconds remaining. Use Stop access to take over.")
                    : "This request expires in " + seconds + " seconds.";
                string selection = selected == null ? "" : WindowLabel(selected) + (control ? " · View and control" : " · View only");
                if (recovery != null) { recovery.Present(announced, title, request.Origin + "\n" + detail +
                    (selection.Length == 0 ? "" : "\n" + selection), status); return; }
                dialog.Render(new JavaScriptSerializer().Serialize(new {
                    kind = "consent", active = announced, title, origin = request.Origin, detail, status, control, pickWindow = !WholeDesktop,
                    foregroundLabel = ForegroundLabel,
                    windows = windows.Select((entry, index) => new { value = index.ToString(CultureInfo.InvariantCulture),
                        label = WindowLabel(entry), disabled = destroyed.Contains(entry.Handle) }).ToArray(), selected = selection
                }));
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
