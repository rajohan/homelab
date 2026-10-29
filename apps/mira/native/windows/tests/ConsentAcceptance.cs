using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Web.Script.Serialization;
using Homelab.Mira.Computer;

// Non-distributed acceptance entrypoint. It controls only fresh fixture/consent
// children on a disposable hosted runner. Lock is last: no unlock is attempted.
internal static class ConsentAcceptance
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool LockWorkStation();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string stage = "startup";
    private static string detail = "startup";

    private sealed class Child : IDisposable
    {
        internal readonly Process Process;
        private readonly Task<string> errors;
        internal Child(string executable)
        {
            Process = Process.Start(new ProcessStartInfo(executable)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false, true),
                StandardErrorEncoding = new UTF8Encoding(false, true)
            });
            errors = Process.StandardError.ReadToEndAsync();
        }
        internal void Send(object value)
        {
            Process.StandardInput.WriteLine(Json.Serialize(value));
            Process.StandardInput.Flush();
        }
        internal Dictionary<string, object> Read()
        {
            var line = Process.StandardOutput.ReadLineAsync();
            if (!line.Wait(8000)) throw new InvalidOperationException("Pipe deadline exceeded.");
            return ConsentProtocol.Object(line.Result);
        }
        internal void Exited()
        {
            if (!Process.WaitForExit(4000)) throw new InvalidOperationException("Child did not retire.");
            if (!errors.Wait(1000)) throw new InvalidOperationException("Child pipe did not close.");
        }
        public void Dispose()
        {
            try
            {
                if (!Process.HasExited)
                {
                    Process.Kill();
                    if (!Process.WaitForExit(4000)) throw new InvalidOperationException("Child cleanup failed.");
                }
            }
            finally { Process.Dispose(); }
        }
    }

    private static Dictionary<string, object> Object(Dictionary<string, object> value, string name)
    {
        var result = value[name] as Dictionary<string, object>;
        if (result == null) throw new InvalidDataException("Expected an object.");
        return result;
    }
    private static void Require(bool value)
    {
        if (!value) throw new InvalidOperationException("Acceptance assertion failed.");
    }
    private static void Wait(Func<bool> ready)
    {
        var deadline = Stopwatch.StartNew();
        while (!ready())
        {
            if (deadline.ElapsedMilliseconds >= 8000) throw new InvalidOperationException("Acceptance deadline exceeded.");
            Thread.Sleep(50);
        }
    }
    private static AutomationElement Find(AutomationElement parent, ControlType type, string name)
    {
        AutomationElement element = null;
        Wait(delegate
        {
            element = parent.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, type),
                new PropertyCondition(AutomationElement.NameProperty, name)));
            return element != null;
        });
        return element;
    }
    private static object Request()
    {
        return new
        {
            id = Guid.NewGuid().ToString("D"), runId = Guid.NewGuid().ToString("D"),
            origin = "https://computer.example.test", mode = "control",
            consentExpiresAt = DateTime.UtcNow.AddSeconds(50).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            expiresAt = DateTime.UtcNow.AddMinutes(2).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
        };
    }
    private static void Initialize(Child host)
    {
        host.Send(new { id = 1, method = "initialize", @params = Request() });
        var initialized = host.Read();
        Require((int)initialized["id"] == 1 && (int)Object(initialized, "result")["protocol"] == 1);
    }
    private static AutomationElement Approve(Child host, Dictionary<string, object> target)
    {
        detail = "prompt handle";
        Wait(delegate { host.Process.Refresh(); return host.Process.MainWindowHandle != IntPtr.Zero; });
        var window = AutomationElement.FromHandle(host.Process.MainWindowHandle);
        Require(window.Current.ProcessId == host.Process.Id);
        detail = "approval button";
        var allow = Find(window, ControlType.Button, "Allow control");
        Require(!allow.Current.IsEnabled);
        detail = "fixture list item";
        var item = Find(window, ControlType.ListItem, (string)target["title"]);
        detail = "fixture selection";
        ((SelectionItemPattern)item.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
        Require(!allow.Current.IsEnabled); // Selecting a window alone cannot grant foreground input.
        detail = "foreground checkbox";
        var checkbox = Find(window, ControlType.CheckBox, "Allow Mira to bring this window forward while clicking or typing.");
        var toggle = (TogglePattern)checkbox.GetCurrentPattern(TogglePattern.Pattern);
        Require(toggle.Current.ToggleState == ToggleState.Off);
        detail = "foreground approval";
        toggle.Toggle();
        Wait(delegate { return allow.Current.IsEnabled; });
        ((InvokePattern)allow.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
        detail = "selection receipt";
        var selection = host.Read();
        Require((string)selection["method"] == "consent/selected");
        var selected = Object(Object(selection, "params"), "target");
        foreach (string field in new[] { "pid", "windowId", "startedAt" }) Require(selected[field].Equals(target[field]));
        Require(String.Equals((string)selected["executable"], (string)target["executable"], StringComparison.OrdinalIgnoreCase));
        Require((string)selected["delivery"] == "foreground");
        detail = "readiness receipt";
        host.Send(new { id = 2, method = "check", @params = new { } });
        var check = host.Read();
        Require((int)check["id"] == 2 && (bool)Object(check, "result")["ready"]);
        return window;
    }
    private static void Stopped(Child host)
    {
        detail = "stop receipt";
        var message = host.Read();
        Require((string)message["method"] == "consent/stopped");
        Require(Object(message, "params").Count == 0);
        detail = "stopped process exit";
        host.Exited();
        Require(host.Process.StandardOutput.ReadToEnd() == "");
    }
    private static void Run(string hostPath, string fixturePath, string reason)
    {
        stage = reason;
        using (var fixture = new Child(fixturePath))
        using (var host = new Child(hostPath))
        {
            fixture.Send(new { id = 1, method = "state", @params = new { } });
            var target = Object(fixture.Read(), "result");
            Require((int)target["pid"] == fixture.Process.Id);
            Initialize(host);
            var window = Approve(host, target);
            var transition = Stopwatch.StartNew();
            detail = "transition dispatch";
            if (reason == "local-stop")
                ((InvokePattern)Find(window, ControlType.Button, "Stop access").GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            else if (reason == "parent-loss") host.Process.StandardInput.Close();
            else if (reason == "target-exit") { fixture.Process.StandardInput.Close(); fixture.Exited(); }
            else
            {
                NativeWindows.ReadyDesktop();
                Require(LockWorkStation());
                // Success from LockWorkStation only initiates the transition. Require
                // independent desktop refusal and the actual host's terminal receipt.
                Wait(delegate
                {
                    try { NativeWindows.ReadyDesktop(); return false; }
                    catch (InvalidOperationException) { return true; }
                });
            }
            Stopped(host);
            Require(transition.ElapsedMilliseconds < 4500); // Do not pass via the five-second parent watchdog.
        }
    }
    [MTAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2 || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
            Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows") return 2;
        try
        {
            foreach (string reason in new[] { "local-stop", "parent-loss", "target-exit", "lock" }) Run(args[0], args[1], reason);
            stage = "locked-startup";
            using (var host = new Child(args[0]))
            {
                host.Send(new { id = 1, method = "initialize", @params = Request() });
                host.Exited();
                Require(host.Process.ExitCode == 1 && host.Process.StandardOutput.ReadToEnd() == "");
            }
            Console.WriteLine("{\"windowsConsentAcceptance\":\"passed\",\"localStop\":true,\"parentLoss\":true,\"targetExit\":true,\"locked\":true,\"lockedStartupDenied\":true}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows consent acceptance failed at " + stage + " / " + detail + " (" + error.GetType().Name + ").");
            return 1;
        }
    }
}
