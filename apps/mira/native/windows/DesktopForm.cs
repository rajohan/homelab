using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class DesktopForm : Form
{
    private readonly string package, settings;
    private readonly TextBox code = new TextBox();
    private readonly Label status = new Label();
    private readonly Button connect = new DesktopButton(), pair = new DesktopButton(), forget = new DesktopButton(), stop = new DesktopButton(), update = new DesktopButton();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly ContextMenuStrip trayMenu = new ContextMenuStrip();
    private readonly ToolStripMenuItem trayStop = new ToolStripMenuItem("Stop connection");
    private DesktopSession session;
    private DesktopUpdateSession download;
    private readonly Action<bool> maintenance;
    private bool installing;
    private bool closing, blocked, stopping;

    internal DesktopForm(string packageDirectory, string settingsDirectory)
        : this(packageDirectory, settingsDirectory, null) { }

    internal DesktopForm(string packageDirectory, string settingsDirectory, Action<bool> installation)
        : this(packageDirectory, settingsDirectory, installation, false) { }

    internal DesktopForm(string packageDirectory, string settingsDirectory, Action<bool> installation, bool startup)
    {
        maintenance = installation;
        package = packageDirectory; settings = settingsDirectory;
        Text = "Mira · Computer connection";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(15, 23, 42);
        ForeColor = Color.FromArgb(226, 232, 240);
        ClientSize = new Size(600, 390);
        MinimumSize = new Size(520, 410);
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScroll = true;
        var layout = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(24), ColumnCount = 1 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.Controls.Add(new Label { Text = "Connect this computer", AutoSize = true, Font = new Font(Font.FontFamily, 18, FontStyle.Bold), Margin = new Padding(0, 0, 0, 10) });
        var explanation = new Label { Text = "Connect to Homelab at home or through Meshnet. Window access is approved separately for each request.", AutoSize = true, Margin = new Padding(0, 0, 0, 20) };
        layout.Controls.Add(explanation);
        EventHandler wrap = delegate
        {
            var size = new Size(Math.Max(180, ClientSize.Width - 48 - SystemInformation.VerticalScrollBarWidth), 0);
            explanation.MaximumSize = status.MaximumSize = size;
        };
        ClientSizeChanged += wrap;
        wrap(this, EventArgs.Empty);
        layout.Controls.Add(new Label { Text = "Pairing code from Settings > Computers", AutoSize = true, Margin = new Padding(0, 12, 0, 6) });
        ConfigureField(code); code.MaxLength = 128; code.UseSystemPasswordChar = true;
        layout.Controls.Add(code);
        var pairing = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, Margin = new Padding(0, 10, 0, 16) };
        ConfigureButton(pair, "Pair computer"); ConfigureButton(forget, "Remove pairing");
        pairing.Controls.Add(pair); pairing.Controls.Add(forget); layout.Controls.Add(pairing);
        status.AutoSize = true; status.Text = "Disconnected"; status.Margin = new Padding(0, 4, 0, 14);
        layout.Controls.Add(status);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = true, Margin = new Padding(0) };
        ConfigureButton(connect, "Connect"); ConfigureButton(stop, "Stop"); ConfigureButton(update, "Update app");
        actions.Controls.Add(connect); actions.Controls.Add(stop); actions.Controls.Add(update); layout.Controls.Add(actions);
        Controls.Add(layout);
        tray.Icon = Icon;
        tray.Text = "Mira · Disconnected";
        trayMenu.Items.Add("Open Mira", null, delegate { RestoreWindow(); });
        trayMenu.Items.Add(trayStop);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, delegate { Close(); });
        tray.ContextMenuStrip = trayMenu;
        tray.DoubleClick += delegate { RestoreWindow(); };
        trayStop.Click += delegate { Stop(); };
        status.TextChanged += delegate
        {
            string description = "Mira · " + status.Text;
            tray.Text = description.Length > 63 ? description.Substring(0, 63) : description;
        };
        if (startup) { WindowState = FormWindowState.Minimized; ShowInTaskbar = false; }
        Shown += async delegate {
            tray.Visible = true;
            if (startup) {
                Hide();
                await StartAtSignIn();
            }
        };
        Resize += delegate
        {
            if (WindowState == FormWindowState.Minimized && tray.Visible)
            {
                ShowInTaskbar = false;
                Hide();
            }
        };
        code.TextChanged += delegate { UpdateActions(); };
        connect.Click += async delegate { await Start("run"); };
        pair.Click += async delegate { await Start("pair"); };
        forget.Click += async delegate
        {
            if (MessageBox.Show(this, "Remove the saved pairing for this server? Revoke this computer in Settings to end server access.", "Remove pairing", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
                await Start("forget");
        };
        stop.Click += delegate { Stop(); };
        update.Click += async delegate { await UpdateApp(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args)
        {
            if (installing) { args.Cancel = true; status.Text = "Installing update… Wait for setup to finish."; }
            else if (session != null || download != null) { args.Cancel = true; closing = true; Stop(); }
        };
        SystemEvents.SessionSwitch += SessionChanged;
        SystemEvents.PowerModeChanged += PowerChanged;
        UpdateActions();
    }

    private Task StartAtSignIn()
    {
        return Start("run");
    }

    private void ConfigureField(TextBox field)
    {
        field.Dock = DockStyle.Fill; field.Margin = new Padding(0);
        field.BackColor = Color.FromArgb(30, 41, 59); field.ForeColor = ForeColor;
        field.BorderStyle = BorderStyle.FixedSingle;
    }
    private static void ConfigureButton(Button button, string text)
    {
        button.Text = text; button.AutoSize = true; button.FlatStyle = FlatStyle.Flat;
        button.Padding = new Padding(12, 5, 12, 5); button.Margin = new Padding(0, 0, 10, 4);
    }
    private void UpdateActions()
    {
        bool idle = session == null && download == null && !blocked && !installing && !closing;
        code.Enabled = idle;
        pair.Enabled = idle && code.Text.Length > 0;
        connect.Enabled = forget.Enabled = idle;
        update.Enabled = idle && maintenance != null;
        stop.Enabled = trayStop.Enabled = (session != null || download != null) && !stopping && !installing;
    }
    private async Task Start(string operation)
    {
        if (session != null || download != null || installing || blocked || closing) return;
        DesktopSession current = null;
        try
        {
            string origin = DesktopSettings.ServerOrigin;
            current = new DesktopSession(package, operation, origin, operation == "pair" ? code.Text : null);
            code.Clear();
            session = current;
            stopping = false;
            status.Text = operation == "pair" ? "Pairing…" : operation == "forget" ? "Removing pairing…" : "Connecting…";
            UpdateActions();
            DesktopResult result = await current.Run(delegate(string state)
            {
                try
                {
                    if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate
                    {
                        if (session == current && !closing && stop.Enabled) status.Text = state;
                    });
                }
                catch (InvalidOperationException) { }
            });
            blocked = !result.Clean;
            if (blocked) status.Text = "Process cleanup could not be confirmed. Close Mira and check Windows before restarting.";
            else if (operation == "pair") status.Text = result.Success && !result.Stopped ? "Paired. Select Connect when ready." : "Pairing was not confirmed. Revoke the ticket or computer in Settings before trying again.";
            else if (operation == "forget") status.Text = result.Success ? "Local pairing removed. Revoke the computer in Settings too." : "The local pairing could not be removed.";
            else status.Text = result.Stopped ? "Disconnected" : "Connection ended. Check your home network or Meshnet connection and pairing before reconnecting.";
        }
        catch (ArgumentException error) { status.Text = error.Message; }
        catch
        {
            blocked = session != null;
            status.Text = blocked ? "Process cleanup could not be confirmed. Close Mira and check Windows before restarting." : "The computer connection could not start. Check the local installation and your home network or Meshnet connection.";
        }
        finally
        {
            code.Clear();
            if (current != null) current.Dispose();
            session = null;
            stopping = false;
            UpdateActions();
            if (closing) Close();
        }
    }
    private async Task UpdateApp()
    {
        if (session != null || download != null || installing || blocked || closing || maintenance == null) return;
        DesktopUpdateSession current = null;
        DesktopUpdateArtifact artifact = null;
        bool released = false, completed = false;
        try {
            string origin = DesktopSettings.ServerOrigin;
            code.Clear();
            current = new DesktopUpdateSession(package, origin, settings);
            download = current; stopping = false;
            status.Text = "Checking and downloading update…";
            UpdateActions();
            var result = await current.Run();
            artifact = result.Artifact;
            blocked = !result.Clean;
            if (blocked) { status.Text = "Update cleanup could not be confirmed. Close Mira before trying again."; return; }
            if (closing || stopping) { status.Text = "Update cancelled."; return; }
            if (artifact == null) { status.Text = "No verified update was downloaded. Check the server and pairing, or try again later."; return; }
            artifact.RequireFresh();
            installing = true;
            status.Text = "Installing Mira " + artifact.Version + "…";
            UpdateActions();
            maintenance(true); released = true;
            bool success = await Task.Run((Func<bool>)artifact.Install);
            completed = true;
            if (success) {
                MessageBox.Show(this, "Mira was updated. Open Mira again from the Start menu; your pairing is kept.", "Update installed", MessageBoxButtons.OK, MessageBoxIcon.Information);
                closing = true;
            } else status.Text = "Setup did not complete. Close other Mira clients and try again.";
        }
        catch {
            blocked = true;
            status.Text = "The update could not be confirmed. Let any setup finish, then reopen Mira from Start.";
        }
        finally {
            installing = false;
            if (released && completed && !closing) {
                try { maintenance(false); } catch { blocked = true; }
            }
            if (artifact != null) {
                try { artifact.Dispose(); } catch { blocked = true; }
            }
            if (current != null) current.Dispose();
            download = null; stopping = false;
            UpdateActions();
            if (closing) Close();
        }
    }

    private void Stop()
    {
        if (installing || (session == null && download == null)) return;
        status.Text = "Stopping…";
        stopping = true;
        UpdateActions();
        if (session != null) session.Stop();
        if (download != null) download.Stop();
    }
    private void RestoreWindow()
    {
        if (closing) return;
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }
    private void SessionChanged(object sender, SessionSwitchEventArgs args)
    {
        try { if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)Stop); } catch (InvalidOperationException) { }
    }
    private void PowerChanged(object sender, PowerModeChangedEventArgs args)
    {
        if (args.Mode == PowerModes.Suspend || args.Mode == PowerModes.Resume) SessionChanged(sender, null);
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.SessionSwitch -= SessionChanged;
            SystemEvents.PowerModeChanged -= PowerChanged;
            if (session != null) session.Stop();
            if (download != null) download.Stop();
            tray.Visible = false;
            tray.Dispose();
            trayMenu.Dispose();
        }
        base.Dispose(disposing);
    }
}
