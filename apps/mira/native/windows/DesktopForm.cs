using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class DesktopForm : MiraWindow
{
    private readonly DesktopConnection connection;
    private readonly DesktopWebView web;
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly ContextMenuStrip trayMenu = new ContextMenuStrip();
    private readonly ToolStripMenuItem trayStop = new ToolStripMenuItem("Stop computer connection");
    private readonly ToolStripMenuItem trayUpdate = new ToolStripMenuItem("Check for updates…");
    private readonly Button updateButton = new DesktopButton();
    private bool opened;
    internal string InstalledVersion { get { return connection.InstalledVersion; } }
    internal bool ReconnectAfterUpdate { get { return connection.ReconnectAfterUpdate; } }

    internal DesktopForm(string package, string settings) : this(package, settings, null, false) { }
    internal DesktopForm(string package, string settings, Action<bool> installation) : this(package, settings, installation, false) { }
    internal DesktopForm(string package, string settings, Action<bool> installation, bool startup, bool connectOnOpen = true)
    {
        Text = "Mira"; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(1280, 820); MinimumSize = new Size(640, 520);
        StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        connection = new DesktopConnection(package, settings, installation, delegate(Action action) {
            try { if (!IsDisposed && IsHandleCreated) BeginInvoke(action); } catch (InvalidOperationException) { }
        });
        web = new DesktopWebView(settings, Receive); Content.Controls.Add(web);
        updateButton.Text = "Check for updates"; updateButton.AccessibleName = "Check for Mira updates";
        updateButton.FlatStyle = FlatStyle.Flat; updateButton.FlatAppearance.BorderSize = 0;
        updateButton.ForeColor = Accent; updateButton.BackColor = Surface;
        updateButton.FlatAppearance.MouseOverBackColor = Raised;
        updateButton.Cursor = Cursors.Hand;
        updateButton.Click += delegate { Observe(connection.UpdateApp(this)); };
        SetCaptionAction(updateButton);
        tray.Icon = Icon; tray.Text = "Mira";
        trayMenu.Items.Add("Open Mira", null, async delegate { await RestoreWindow(false); });
        trayMenu.Items.Add("Settings", null, async delegate { await RestoreWindow(true); });
        trayMenu.Items.Add(trayUpdate);
        trayMenu.Items.Add(trayStop); trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, delegate { Close(); });
        tray.ContextMenuStrip = trayMenu;
        tray.DoubleClick += async delegate { await RestoreWindow(false); };
        trayStop.Click += delegate { connection.Stop(); };
        trayUpdate.Click += delegate { Observe(RestoreWindow(false)); Observe(connection.UpdateApp(this)); };
        trayStop.Enabled = connection.CanStop;
        trayUpdate.Enabled = updateButton.Enabled = connection.CanUpdate;
        connection.Changed += delegate {
            string description = "Mira · " + connection.Message;
            tray.Text = description.Length > 63 ? description.Substring(0, 63) : description;
            trayStop.Enabled = connection.CanStop;
            trayUpdate.Enabled = updateButton.Enabled = connection.CanUpdate;
            updateButton.Text = connection.Updating ? "Updating…" : "Check for updates";
        };
        connection.ExitRequested += delegate { Close(); };
        if (startup) { WindowState = FormWindowState.Minimized; ShowInTaskbar = false; }
        Shown += async delegate {
            tray.Visible = true;
            if (connectOnOpen) Observe(connection.Start("run"));
            if (startup) Hide();
            else { opened = true; await web.Open(); }
        };
        Resize += delegate {
            if (WindowState == FormWindowState.Minimized && tray.Visible) { ShowInTaskbar = false; Hide(); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs args) { args.Cancel = !connection.Close(); };
        SystemEvents.SessionSwitch += SessionChanged; SystemEvents.PowerModeChanged += PowerChanged;
    }
    private string Receive(string source, string json)
    {
        var request = DesktopBridge.Read(source, web.Source, json);
        string action = (string)request["action"];
        if (action != "state" && (((action == "connect" || action == "pair" || action == "forget") && !connection.CanStart) || (action == "update" && !connection.CanUpdate)))
            return DesktopBridge.Reply((string)request["id"], connection, "Finish or stop the current computer operation first.");
        if (action == "pair" && connection.ComputerId != null)
            return DesktopBridge.Reply((string)request["id"], connection, "Remove the existing local pairing before pairing this PC again.");
        if (action == "connect") Observe(connection.Start("run"));
        else if (action == "pair") Observe(connection.Start("pair", (string)request["ticket"]));
        else if (action == "stop") connection.Stop();
        else if (action == "forget") Observe(connection.Start("forget"));
        else if (action == "update") Observe(connection.UpdateApp(this));
        return DesktopBridge.Reply((string)request["id"], connection);
    }
    private static async void Observe(Task task) { try { await task; } catch { } }
    private async Task RestoreWindow(bool settings)
    {
        ShowInTaskbar = true; Show(); WindowState = FormWindowState.Normal; Activate();
        if (!opened) { opened = true; await web.Open(); }
        if (settings) web.Settings();
    }
    private void SessionChanged(object sender, SessionSwitchEventArgs args)
    {
        try { if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)connection.Stop); } catch (InvalidOperationException) { }
    }
    private void PowerChanged(object sender, PowerModeChangedEventArgs args)
    {
        if (args.Mode == PowerModes.Suspend || args.Mode == PowerModes.Resume) SessionChanged(sender, null);
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) {
            SystemEvents.SessionSwitch -= SessionChanged; SystemEvents.PowerModeChanged -= PowerChanged;
            connection.Dispose(); tray.Visible = false; tray.Dispose(); trayMenu.Dispose();
        }
        base.Dispose(disposing);
    }
}
