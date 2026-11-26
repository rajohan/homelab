using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// This surface can load only the three immutable resources embedded in the Windows client.
// The dashboard and other web documents cannot send an install decision to this channel.
internal sealed class DesktopDialogView : WebView2
{
    private const string Origin = "https://homelab-dialog.invalid";
    private const string Page = Origin + "/index.html";
    private readonly string profile;
    private bool started, ready, failed;
    private string state;
    internal bool HasPresented { get; private set; }
    internal event Action<string> Decision;
    internal event Action Unavailable;

    internal DesktopDialogView(string profile)
    {
        this.profile = profile;
        Dock = DockStyle.Fill;
        DefaultBackgroundColor = Color.Transparent;
    }
    internal void Render(string json)
    {
        state = json;
        if (ready) {
            try { CoreWebView2.PostWebMessageAsJson(json); } catch (InvalidOperationException) { Fail(); }
        } else if (!started && json != "null") Open();
    }
    private async void Open()
    {
        started = true;
        CheckStartup();
        try {
            if (File.Exists(profile)) throw new IOException();
            for (var item = new DirectoryInfo(profile); item != null; item = item.Parent)
                if (item.Exists && (item.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException();
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            if (IsDisposed || failed) return;
            await EnsureCoreWebView2Async(env);
            if (IsDisposed || failed) return;
            var core = CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e) {
                string url = e.Request.Uri;
                string file = url == Page ? "index.html" : url == Origin + "/main.js" ? "main.js" : url == Origin + "/dialog.css" ? "dialog.css" : null;
                Stream data = file == null || e.Request.Method != "GET" ? null : typeof(DesktopDialogView).Assembly.GetManifestResourceStream(file);
                string type = file == "index.html" ? "text/html" : file == "main.js" ? "text/javascript" : "text/css";
                e.Response = env.CreateWebResourceResponse(data, data == null ? 403 : 200, data == null ? "Forbidden" : "OK",
                    "Content-Type: " + type + "; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
            };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { e.Cancel = e.Uri != Page; };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { e.Cancel = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            core.ProcessFailed += delegate { Fail(); };
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
                if (e.Source != Page || core.Source != Page || IsDisposed || failed) return;
                string action = e.TryGetWebMessageAsString();
                if (action == "ready") {
                    ready = true; HasPresented = true;
                    Render(state);
                    if (Visible) Focus();
                } else if (ready && Visible && action.Length <= 24) {
                    BeginInvoke((Action)delegate {
                        if (!IsDisposed && Visible && core.Source == Page && Decision != null) Decision(action);
                    });
                }
            };
            core.Navigate(Page);
        } catch { if (!IsDisposed) Fail(); }
    }
    private async void CheckStartup()
    {
        await Task.Delay(10000);
        if (!IsDisposed && !ready) Fail();
    }
    private void Fail()
    {
        if (failed) return;
        failed = true; ready = false;
        if (!IsDisposed && Unavailable != null) Unavailable();
    }
}
