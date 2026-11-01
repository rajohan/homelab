using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Render the real server UI; no duplicated React bundle or local application server.
internal sealed class DesktopWebView : UserControl
{
    private readonly string profile;
    private readonly Func<string, string, string> message;
    private readonly Action<string> external;
    private WebView2 view;
    private readonly Label notice = new Label();
    private readonly Button retry = new DesktopButton();
    private readonly Button runtime = new DesktopButton();
    private readonly FlowLayoutPanel fallback = new FlowLayoutPanel();
    private bool loading;

    internal DesktopWebView(string directory, Func<string, string, string> receive, Action<string> openExternal = null)
    {
        profile = Path.Combine(directory, "WebView2"); message = receive; external = openExternal ?? LaunchExternal;
        Dock = DockStyle.Fill; BackColor = Color.FromArgb(2, 6, 23);
        ForeColor = Color.FromArgb(226, 232, 240); Font = new Font("Segoe UI", 11);
        fallback.Dock = DockStyle.Fill; fallback.FlowDirection = FlowDirection.TopDown;
        fallback.Padding = new Padding(32); fallback.WrapContents = false;
        notice.Text = "Opening Mira…"; notice.AutoSize = true; notice.Margin = new Padding(0, 0, 0, 20);
        retry.Text = "Try again"; retry.AutoSize = true; retry.Visible = false;
        retry.Click += async delegate { await Open(); };
        runtime.Text = "Install Microsoft WebView2"; runtime.AutoSize = true; runtime.Visible = false;
        runtime.Click += delegate { OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/#download-section"); };
        fallback.Controls.Add(notice); fallback.Controls.Add(retry); fallback.Controls.Add(runtime);
        Controls.Add(fallback);
        Resize += delegate { notice.MaximumSize = new Size(Math.Max(200, Width - 64), 0); };
    }
    internal async Task Open()
    {
        if (loading || IsDisposed) return;
        loading = true; retry.Visible = runtime.Visible = false;
        notice.Text = "Opening Mira…"; fallback.Visible = true; fallback.BringToFront();
        try {
            if (view != null) { Controls.Remove(view); view.Dispose(); view = null; }
            for (var parent = new DirectoryInfo(profile); parent != null; parent = parent.Parent)
                if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException();
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            if (IsDisposed) return;
            view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(view);
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            Configure(view.CoreWebView2);
            view.CoreWebView2.Navigate(DesktopBridge.Dashboard + "/mira");
        } catch (WebView2RuntimeNotFoundException) {
            notice.Text = "Mira needs Microsoft Edge WebView2. Install it, then try again."; runtime.Visible = true; retry.Visible = true;
        } catch { notice.Text = "Mira could not open. Check the installation and try again."; retry.Visible = true; }
        finally { loading = false; }
    }
    // Also exercised by the native fixture against virtual, synthetic HTTPS pages.
    internal void Configure(CoreWebView2 core)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Document);
        core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
            if (args.ResourceContext == CoreWebView2WebResourceContext.Document && !DesktopBridge.ApplicationUrl(args.Request.Uri))
                args.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "Content-Type: text/plain");
        };
        core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
            if (DesktopBridge.ApplicationUrl(args.Uri)) return;
            args.Cancel = true;
            if (args.IsUserInitiated && !args.IsRedirected && DesktopBridge.ExternalUrl(args.Uri)) OpenExternal(args.Uri);
        };
        core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
            if (!DesktopBridge.ApplicationUrl(args.Uri) && args.Uri != "about:blank") args.Cancel = true;
        };
        core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) {
            args.Handled = true;
            if (!args.IsUserInitiated) return;
            if (DesktopBridge.ApplicationUrl(args.Uri)) core.Navigate(args.Uri);
            else if (DesktopBridge.ExternalUrl(args.Uri)) OpenExternal(args.Uri);
        };
        core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) {
            if (!DesktopBridge.ApplicationUrl(args.Uri)) args.State = CoreWebView2PermissionState.Deny;
        };
        core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
            try {
                if (!DesktopBridge.SameOrigin(args.Source, DesktopBridge.Dashboard) || !DesktopBridge.SameOrigin(core.Source, DesktopBridge.Dashboard)) return;
                string reply = message(args.Source, args.WebMessageAsJson);
                if (reply != null && DesktopBridge.SameOrigin(core.Source, DesktopBridge.Dashboard)) core.PostWebMessageAsJson(reply);
            } catch { /* Invalid messages never reach operations or diagnostics. */ }
        };
        core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
            if (args.IsSuccess) { fallback.Visible = false; if (view != null) view.BringToFront(); }
            else if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) {
                notice.Text = "Mira is unavailable. Connect to your home network or Meshnet and try again.";
                retry.Visible = fallback.Visible = true; fallback.BringToFront();
            }
        };
        core.ProcessFailed += delegate {
            notice.Text = "The app view stopped. Your work continues on the server.";
            retry.Visible = fallback.Visible = true; fallback.BringToFront();
        };
    }
    internal string Source { get { return view == null || view.CoreWebView2 == null ? "" : view.CoreWebView2.Source; } }
    internal void Settings()
    {
        if (view != null && view.CoreWebView2 != null) view.CoreWebView2.Navigate(DesktopBridge.Dashboard + "/settings");
    }
    private void OpenExternal(string url)
    {
        if (!DesktopBridge.ExternalUrl(url)) return;
        external(url);
    }
    private static void LaunchExternal(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}
