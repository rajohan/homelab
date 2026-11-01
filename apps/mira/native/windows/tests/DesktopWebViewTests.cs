using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class DesktopWebViewTests
{
    private static int browserChecks;
    internal static void Boundaries(Action<bool> require)
    {
        string dashboard = DesktopBridge.Dashboard, auth = DesktopBridge.Auth;
        string state = "{\"type\":\"mira-desktop\",\"protocol\":1,\"id\":\"12345678-1234-4234-8234-123456789abc\",\"action\":\"state\"}";
        require(DesktopBridge.Read(dashboard + "/settings", dashboard, state)["action"].Equals("state"));
        require(DesktopBridge.ApplicationUrl(auth + "/sign-in?interaction=fixture"));
        require(DesktopBridge.ApplicationUrl(dashboard + "/auth/callback?code=fixture"));
        foreach (string source in new[] { auth, dashboard + ".evil.test", "https://user@dashboard.home.rajohan.no", "http://dashboard.home.rajohan.no", "file:///test", "data:text/html,test", "https://dashboard.home.rajohan.no:3443" }) {
            bool rejected = false;
            try { DesktopBridge.Read(source, dashboard, state); } catch { rejected = true; }
            require(rejected);
        }
        foreach (string input in new[] { state.Replace("\"state\"", "\"shell\""), state.Replace("1,", "2,"), state.Replace("\"action\"", "\"command\""), state.Replace("\"state\"", "\"pair\""), state.Replace("}", ",\"path\":\"C:/test\"}"), new string('x', 4097) }) {
            bool rejected = false;
            try { DesktopBridge.Read(dashboard, dashboard, input); } catch { rejected = true; }
            require(rejected);
        }
        bool navigated = false;
        try { DesktopBridge.Read(dashboard, auth, state); } catch { navigated = true; }
        require(navigated);
        foreach (string url in new[] { "file:///test", "javascript:alert(1)", "ms-settings:test", "https://name:password@example.test" }) require(!DesktopBridge.ExternalUrl(url));
        require(DesktopBridge.ExternalUrl("https://example.test/help"));
    }
    internal static void Browser(string root)
    {
        int received = 0, denied = 0, external = 0;
        bool inWebViewCallback = false;
        using (var form = new Form { ShowInTaskbar = false })
        using (var web = new WebView2 { Dock = DockStyle.Fill })
        using (var policy = new DesktopWebView(root, delegate(string source, string json) {
            Check(!inWebViewCallback);
            var request = DesktopBridge.Read(source, web.CoreWebView2.Source, json);
            received++;
            return new JavaScriptSerializer().Serialize(new { type = "fixture-reply", id = request["id"] });
        }, delegate(string url) { Check(url == "https://untrusted.example.test/"); external++; })) {
            form.Controls.Add(web); IntPtr handle = form.Handle;
            var environment = Wait(CoreWebView2Environment.CreateAsync(null, Path.Combine(root, "browser-profile")));
            Wait(web.EnsureCoreWebView2Async(environment));
            var core = web.CoreWebView2;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
                // Every request is served in-process; no real dashboard, auth or account is accessed.
                string html = "<title>Mira fixture</title><h1>Shared dashboard</h1><script>window.receipts=[];chrome.webview.addEventListener('message',e=>receipts.push(e.data));</script>";
                if (!DesktopBridge.ApplicationUrl(args.Request.Uri)) html = "Blocked fixture request";
                args.Response = environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(html)), 200, "OK", "Content-Type: text/html; charset=utf-8");
            };
            core.WebMessageReceived += delegate { inWebViewCallback = true; };
            policy.Configure(core);
            core.WebMessageReceived += delegate { inWebViewCallback = false; };
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
                if (!DesktopBridge.ApplicationUrl(args.Request.Uri)) { Check(args.Response.StatusCode == 403); denied++; }
            };
            Navigate(core, DesktopBridge.Dashboard + "/mira");
            Check(Wait(core.ExecuteScriptAsync("document.querySelector('h1').textContent")) == "\"Shared dashboard\"");
            string message = "chrome.webview.postMessage({type:'mira-desktop',protocol:1,id:'12345678-1234-4234-8234-123456789abc',action:'state'})";
            Wait(core.ExecuteScriptAsync(message)); Until(delegate { return received == 1; });
            Until(delegate { return Wait(core.ExecuteScriptAsync("receipts.length")) == "1"; });
            Navigate(core, DesktopBridge.Auth + "/sign-in");
            Wait(core.ExecuteScriptAsync(message)); Pump(100); Check(received == 1);
            Navigate(core, DesktopBridge.Dashboard + "/settings");
            Wait(core.ExecuteScriptAsync(message)); Until(delegate { return received == 2; });
            Navigate(core, "https://untrusted.example.test/");
            Check(core.Source == DesktopBridge.Dashboard + "/settings");
            Navigate(core, "file:///C:/Windows/win.ini");
            Check(core.Source == DesktopBridge.Dashboard + "/settings");
            Check(denied >= 1 && !core.Settings.AreHostObjectsAllowed);
            Check(external <= 1);
            bool exited = false;
            environment.BrowserProcessExited += delegate { exited = true; };
            web.Dispose();
            Until(delegate { return exited; });
            Console.WriteLine("{\"windowsWebView\":\"passed\",\"originIsolation\":true,\"sharedAuthNavigation\":true}");
        }
    }
    private static void Navigate(CoreWebView2 core, string url)
    {
        bool done = false;
        EventHandler<CoreWebView2NavigationCompletedEventArgs> completed = delegate { done = true; };
        core.NavigationCompleted += completed;
        try { core.Navigate(url); Until(delegate { return done; }); }
        finally { core.NavigationCompleted -= completed; }
    }
    private static T Wait<T>(Task<T> task) { Until(delegate { return task.IsCompleted; }); return task.GetAwaiter().GetResult(); }
    private static void Wait(Task task) { Until(delegate { return task.IsCompleted; }); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> ready)
    {
        var clock = Stopwatch.StartNew();
        while (!ready()) { if (clock.ElapsedMilliseconds > 15000) throw new TimeoutException("WebView fixture timed out."); Application.DoEvents(); Thread.Sleep(10); }
    }
    private static void Pump(int milliseconds) { var clock = Stopwatch.StartNew(); while (clock.ElapsedMilliseconds < milliseconds) { Application.DoEvents(); Thread.Sleep(10); } }
    private static void Check(bool condition) { browserChecks++; if (!condition) throw new InvalidDataException("WebView fixture failed at " + browserChecks); }
}
