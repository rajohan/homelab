using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
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
    private readonly DesktopStateView fallback = new DesktopStateView(true);
    private readonly Button retry, runtime;
    private bool loading;

    internal DesktopWebView(string directory, Func<string, string, string> receive, Action<string> openExternal = null)
    {
        profile = Path.Combine(directory, "WebView2"); message = receive; external = openExternal ?? LaunchExternal;
        Dock = DockStyle.Fill; BackColor = MiraWindow.Canvas;
        ForeColor = MiraWindow.TextColor; Font = new Font("Segoe UI", 11);
        runtime = fallback.ActionButton("Get WebView2", false, delegate { OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/#download-section"); });
        retry = fallback.ActionButton("Try again", true, async delegate { await Open(); });
        retry.Visible = runtime.Visible = false;
        fallback.Present("Opening Homelab", "Connecting to your dashboard…", DesktopGlyph.Open);
        Controls.Add(fallback);
    }
    internal async Task Open()
    {
        if (loading || IsDisposed) return;
        loading = true; retry.Visible = runtime.Visible = false;
        fallback.Visible = true; fallback.BringToFront();
        fallback.Present("Opening Homelab", "Connecting to your dashboard…", DesktopGlyph.Open);
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
            Unavailable("Install WebView2 to open Homelab", "Homelab uses Microsoft Edge WebView2 to display your dashboard. Install the runtime, then try again.", DesktopGlyph.Open, true);
        } catch { Unavailable("Homelab couldn’t open", "Check the Windows app installation, then try again.", DesktopGlyph.Info); }
        finally { loading = false; }
    }
    private void Unavailable(string title, string description, DesktopGlyph icon, bool showRuntime = false)
    {
        if (IsDisposed) return;
        if (view != null) view.Visible = false;
        fallback.Visible = true; runtime.Visible = showRuntime; retry.Visible = true;
        fallback.Present(title, description, icon); fallback.BringToFront();
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
                string source = args.Source, json = args.WebMessageAsJson;
                if (json.Length > 4096) return;
                // Native confirmation must run after the WebView event returns, never in its callback stack.
                SynchronizationContext.Current.Post(delegate {
                    try {
                        if (IsDisposed || !DesktopBridge.SameOrigin(core.Source, DesktopBridge.Dashboard)) return;
                        string reply = message(source, json);
                        if (reply != null && DesktopBridge.SameOrigin(core.Source, DesktopBridge.Dashboard)) core.PostWebMessageAsJson(reply);
                    } catch { /* Navigated/disposed views cannot receive a stale reply. */ }
                }, null);
            } catch { /* Invalid messages never reach operations or diagnostics. */ }
        };
        core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
            if (args.IsSuccess && args.HttpStatusCode < 500) { fallback.Visible = false; if (view != null) { view.Visible = true; view.BringToFront(); } }
            else if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) {
                Unavailable("Can’t reach Homelab", "Connect this PC to your home network or Meshnet, then try again.", DesktopGlyph.Offline);
            }
        };
        core.ProcessFailed += delegate {
            Unavailable("The app view stopped", "Your work continues on the server. Reopen the dashboard to reconnect.", DesktopGlyph.Open);
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
