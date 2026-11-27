using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class DesktopForm : MiraWindow
{
    private readonly DesktopConnection connection;
    private readonly DesktopWebView web;
    private readonly DesktopUpdateDialog updateDialog;
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly ContextMenuStrip trayMenu = new ContextMenuStrip();
    private readonly ToolStripMenuItem trayConnection, trayUpdate;
    private readonly DesktopButton updateButton = new DesktopButton();
    private readonly ToolTip updateTip = new ToolTip();
    private readonly Timer updateTimer = new Timer { Interval = 15 * 60 * 1000 };
    private bool opened;
    internal string InstalledVersion { get { return connection.InstalledVersion; } }
    internal bool ReconnectAfterUpdate { get { return connection.ReconnectAfterUpdate; } }

    internal DesktopForm(string package, string settings) : this(package, settings, null, false) { }
    internal DesktopForm(string package, string settings, Action<bool> installation) : this(package, settings, installation, false) { }
    internal DesktopForm(string package, string settings, Action<bool> installation, bool startup, bool connectOnOpen = true)
    {
        Text = "Homelab"; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(1280, 820); MinimumSize = new Size(640, 520);
        StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        connection = new DesktopConnection(package, settings, installation, delegate(Action action) {
            try { if (!IsDisposed && IsHandleCreated) BeginInvoke(action); } catch (InvalidOperationException) { }
        });
        web = new DesktopWebView(settings, Receive); Content.Controls.Add(web);
        updateDialog = new DesktopUpdateDialog(Content, web, settings);
        updateButton.IconGlyph = DesktopGlyph.Download;
        updateButton.Visible = false;
        updateButton.Click += delegate { Observe(connection.UpdateApp(updateDialog)); };
        SetCaptionAction(updateButton);
        tray.Icon = Icon; tray.Text = "Homelab";
        trayMenu.ShowImageMargin = !SystemInformation.HighContrast; trayMenu.Font = Font;
        trayMenu.Padding = new Padding(4);
        if (!SystemInformation.HighContrast) trayMenu.Renderer = new DesktopMenuRenderer();
        MenuAction("Open Homelab", DesktopGlyph.Open, async delegate { await RestoreWindow(false); });
        MenuAction("Settings", DesktopGlyph.Settings, async delegate { await RestoreWindow(true); });
        trayMenu.Items.Add(new ToolStripSeparator());
        trayConnection = MenuAction("Connect", DesktopGlyph.Connect, delegate {
            if (connection.Busy) connection.Stop(); else Observe(connection.Start("run"));
        });
        trayUpdate = MenuAction("Check for updates", DesktopGlyph.Download, delegate {
            Observe(RestoreWindow(false));
            Observe(connection.UpdateApp(updateDialog));
        });
        trayMenu.Items.Add(new ToolStripSeparator());
        MenuAction("Exit Homelab", DesktopGlyph.Exit, delegate { Close(); });
        tray.ContextMenuStrip = trayMenu;
        tray.DoubleClick += async delegate { await RestoreWindow(false); };
        connection.Changed += RefreshActions;
        RefreshActions();
        connection.ExitRequested += delegate { Close(); };
        updateTimer.Tick += delegate { Observe(connection.CheckAvailability()); };
        if (startup) { WindowState = FormWindowState.Minimized; ShowInTaskbar = false; }
        Shown += async delegate {
            tray.Visible = true;
            if (connectOnOpen) Observe(connection.Start("run"));
            updateTimer.Start(); Observe(connection.CheckAvailability());
            if (startup) Hide();
            else { opened = true; await web.Open(); }
        };
        Resize += delegate {
            if (WindowState == FormWindowState.Minimized && tray.Visible) { ShowInTaskbar = false; Hide(); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs args) { args.Cancel = !connection.Close(); };
        SystemEvents.SessionSwitch += SessionChanged; SystemEvents.PowerModeChanged += PowerChanged;
    }
    private ToolStripMenuItem MenuAction(string label, DesktopGlyph glyph, EventHandler click)
    {
        var item = new ToolStripMenuItem(label, null, click) {
            Tag = glyph, Padding = new Padding(0, 6, 0, 6), TextAlign = ContentAlignment.MiddleLeft
        };
        trayMenu.Items.Add(item);
        return item;
    }
    private void RefreshActions()
    {
        string description = "Homelab · " + connection.Message;
        tray.Text = description.Length > 63 ? description.Substring(0, 63) : description;
        trayConnection.Text = connection.Updating ? "Cancel update" : connection.Busy ? "Stop connection" : "Connect";
        trayConnection.Tag = connection.Busy ? DesktopGlyph.Stop : DesktopGlyph.Connect;
        trayConnection.Enabled = connection.Busy ? connection.CanStop : connection.CanStart;
        string available = connection.AvailableVersion;
        trayUpdate.Text = connection.Updating ? "View update" : available == null ? "Check for updates" : "Update to Homelab " + available;
        trayUpdate.Enabled = connection.CanOpenUpdate;
        updateButton.Visible = available != null && connection.CanUpdate;
        if (available != null) {
            updateButton.AccessibleName = "Download and install Homelab " + available;
            updateTip.SetToolTip(updateButton, updateButton.AccessibleName);
        }
    }
    private string Receive(string source, string json)
    {
        var request = DesktopBridge.Read(source, web.Source, json);
        string action = (string)request["action"];
        if (action == "startup" || action == "setStartup") {
            try {
                if (action == "setStartup") DesktopStartup.SetEnabled((bool)request["enabled"]);
                return DesktopBridge.Reply((string)request["id"], connection, null, DesktopStartup.Enabled);
            } catch (Exception) {
                return DesktopBridge.Reply((string)request["id"], connection, "Could not change the Windows startup shortcut. Check this account's Startup folder.");
            }
        }
        if (action != "state" && (((action == "connect" || action == "pair" || action == "forget") && !connection.CanStart) || (action == "update" && !connection.CanOpenUpdate)))
            return DesktopBridge.Reply((string)request["id"], connection, "Finish or stop the current computer operation first.");
        if (action == "pair" && connection.ComputerId != null)
            return DesktopBridge.Reply((string)request["id"], connection, "Remove the existing local pairing before pairing this PC again.");
        if (action == "connect") Observe(connection.Start("run"));
        else if (action == "pair") Observe(connection.Start("pair", (string)request["ticket"]));
        else if (action == "stop") connection.Stop();
        else if (action == "forget") Observe(connection.Start("forget"));
        else if (action == "update") Observe(connection.UpdateApp(updateDialog));
        return DesktopBridge.Reply((string)request["id"], connection);
    }
    private static async void Observe(Task task) { try { await task; } catch { } }
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        return (updateDialog != null && updateDialog.ProcessKey(keyData)) || base.ProcessCmdKey(ref msg, keyData);
    }
    private async Task RestoreWindow(bool settings)
    {
        ShowInTaskbar = true; Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
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
            updateTimer.Dispose(); updateTip.Dispose();
            connection.Dispose(); tray.Visible = false; tray.Dispose(); trayMenu.Dispose();
        }
        base.Dispose(disposing);
    }
}
