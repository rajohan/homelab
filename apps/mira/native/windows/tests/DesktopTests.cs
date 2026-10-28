using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class DesktopTests
{
    private static int checks;
    private const string Origin = "https://mira.example.test";
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--qualify-update") {
                using (var artifact = DesktopUpdateArtifact.Receive(Console.OpenStandardInput(), args[1], Stopwatch.StartNew())) {
                    if (!artifact.Install()) return 1;
                }
                Console.WriteLine("Native update installation completed.");
                return 0;
            }
            if (args.Length == 2 && args[0] == "--lease") return InstallationProtocol.Run(args[1]);
            if (args.Length == 2 && args[0] == "--parent")
            {
                using (var session = new DesktopSession(args[1], "run", Origin, null)) session.Run(delegate { }).GetAwaiter().GetResult();
                return 0;
            }
            if ((args.Length == 2 || args.Length == 3) && args[0] == "--preview")
            {
                Application.EnableVisualStyles();
                using (var form = new DesktopForm(AppDomain.CurrentDomain.BaseDirectory, Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "no-settings"), delegate { }))
                {
                    ((TextBox)typeof(DesktopForm).GetField("server", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(form)).Text = "https://mira.example.test";
                    if (args.Length == 3) form.Width = Math.Max(520, Math.Min(1000, int.Parse(args[2])));
                    // Materialize only this owned test form's controls; never show a window or tray icon.
                    var create = typeof(Control).GetMethod("CreateControl", BindingFlags.Instance | BindingFlags.NonPublic, null, new[] { typeof(bool) }, null);
                    create.Invoke(form, new object[] { true });
                    var state = typeof(Control).GetMethod("SetState", BindingFlags.Instance | BindingFlags.NonPublic);
                    state.Invoke(form, new object[] { 2, true });
                    form.PerformLayout();
                    using (var bitmap = new Bitmap(form.Width, form.Height))
                    {
                        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                        state.Invoke(form, new object[] { 2, false });
                        bitmap.Save(args[1], ImageFormat.Png);
                    }
                }
                return 0;
            }
            if (args.Length != 0) return 1;
            string root = AppDomain.CurrentDomain.BaseDirectory;
            Settings(root);
            Installation(root);
            DesktopUpdateTests.Run(root, Require);
            Arguments(root);
            Pairing(root);
            foreach (string mode in new[] { "eof", "hang", "parent-death" }) Lifecycle(root, mode);
            foreach (string mode in new[] { "failure", "oversize" }) Failure(root, mode);
            using (var session = new DesktopSession(root, "run", Origin, null))
            {
                session.Stop();
                DesktopResult result = Complete(session.Run(delegate { }));
                Require(result.Clean && result.Stopped && !result.Success);
                Reject(delegate { session.Run(delegate { }); });
            }
            using (var session = new DesktopSession(Path.Combine(root, "missing"), "run", Origin, null))
            {
                DesktopResult result = Complete(session.Run(delegate { }));
                Require(!result.Clean && !result.Success);
            }
            Console.WriteLine("{\"windowsDesktop\":\"passed\",\"assertions\":" + checks + "}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows desktop qualification failed after " + checks + ": " + error.GetType().Name);
            return 1;
        }
    }
    private static void Settings(string root)
    {
        Require(DesktopSettings.Origin("https://MIRA.example.test:443/") == Origin);
        Require(DesktopSettings.Origin("https://10.0.0.2:8443") == "https://10.0.0.2:8443");
        foreach (string value in new[] { "http://mira.example.test", "https://user:secret@mira.example.test", Origin + "/path", Origin + "?token=value", Origin + "#fragment", Origin + "\n", " https://mira.example.test", "https://mira.example.test:0", "https://mira.example.test:65536", "https://[::1]", "https://mira\\example.test" })
            Reject(delegate { DesktopSettings.Origin(value); });
        string settings = Path.Combine(root, "settings-test");
        Require(DesktopSettings.Load(settings) == "");
        DesktopSettings.Save(settings, Origin);
        Require(DesktopSettings.Load(settings) == Origin);
        DesktopSettings.Save(settings, "https://second.example.test");
        Require(DesktopSettings.Load(settings) == "https://second.example.test");
        Require(Directory.GetFiles(settings).Length == 1);
        File.WriteAllText(Path.Combine(settings, "server.txt"), new string('a', 513));
        Reject(delegate { DesktopSettings.Load(settings); });
        string package = Path.Combine(root, "package-test"); Directory.CreateDirectory(package);
        string executable = Path.Combine(package, "mira-computer-desktop.exe");
        foreach (string name in new[] { "mira-computer-desktop.exe", "mira-computer.exe", "mira-computer-consent.exe", "mira-computer-worker-host.exe", "mira-computer-worker.exe" }) File.WriteAllText(Path.Combine(package, name), "fixture");
        // CI may supply an 8.3 TEMP path; .NET expands it when canonicalizing the package.
        Require(string.Equals(DesktopSettings.PackageDirectory(executable), Path.GetFullPath(package), StringComparison.OrdinalIgnoreCase));
        File.Delete(Path.Combine(package, "mira-computer-worker.exe"));
        Reject(delegate { DesktopSettings.PackageDirectory(executable); });
        Reject(delegate { DesktopSettings.PackageDirectory("mira-computer-desktop.exe"); });
        Reject(delegate { new DesktopSession(root, "pair", Origin, "bad"); });
        Reject(delegate { new DesktopSession(root, "run", Origin, "ticket"); });
    }
    private static void Arguments(string root)
    {
        string directory = Path.Combine(root, "fixture");
        string[] arguments = { "echo", "", "with spaces", "quote\"value", @"C:\with spaces\", "backslash\\\"quote", "line\nvalue", "æøå" };
        using (var child = new WorkerJob(Path.Combine(directory, "mira-computer.exe"), directory, arguments))
        using (var reader = new StreamReader(child.Output, Encoding.UTF8))
        {
            foreach (string value in arguments) Require(reader.ReadLine() == Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
            Require(child.StopAndConfirm());
        }
    }
    private static void Installation(string root)
    {
        string directory = Path.Combine(root, "lease-test");
        using (var first = InstallationLease.Open(directory, false))
        using (var second = InstallationLease.Open(directory, false))
            Reject(delegate { using (var maintenance = InstallationLease.Open(directory, true)) { } });
        using (var maintenance = InstallationLease.Open(directory, true))
            Reject(delegate { using (var reader = InstallationLease.Open(directory, false)) { } });
        using (var maintenance = InstallationLease.Open(directory, true)) Require(maintenance.CanWrite);
        foreach (bool malformed in new[] { false, true })
        {
            var start = new ProcessStartInfo(Application.ExecutablePath, "--lease \"" + directory + "\"");
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var child = Process.Start(start))
            {
                try
                {
                    child.StandardInput.WriteLine("{\"id\":1,\"method\":\"initialize\",\"params\":{}}"); child.StandardInput.Flush();
                    var response = child.StandardOutput.ReadLineAsync();
                    Require(response.Wait(5000) && response.Result.Contains("\"protocol\":1"));
                    Reject(delegate { using (var maintenance = InstallationLease.Open(directory, true)) { } });
                    if (malformed) { child.StandardInput.Write("x"); child.StandardInput.Flush(); }
                    else child.StandardInput.Close();
                    Require(child.WaitForExit(5000)); Require(child.ExitCode == (malformed ? 1 : 0));
                    using (var maintenance = InstallationLease.Open(directory, true)) Require(maintenance.CanWrite);
                }
                finally { if (!child.HasExited) child.Kill(); child.WaitForExit(3000); }
            }
        }
    }
    private static string Fixture(string root, string mode)
    {
        string directory = Path.Combine(root, "case-" + mode); Directory.CreateDirectory(directory);
        File.Copy(Path.Combine(root, "fixture", "mira-computer.exe"), Path.Combine(directory, "mira-computer.exe"));
        File.WriteAllText(Path.Combine(directory, "mode.txt"), mode);
        return directory;
    }
    private static void Pairing(string root)
    {
        string directory = Fixture(root, "pair");
        string ticket = "mira_pair_12345678-1234-1234-1234-123456789abc." + new string('A', 43);
        using (var session = new DesktopSession(directory, "pair", Origin, ticket))
        {
            DesktopResult result = Complete(session.Run(delegate { }));
            Require(result.Clean && result.Success && !result.Stopped);
            Require(File.ReadAllText(Path.Combine(directory, "pair-result.txt")) == "private-stdin");
        }
        using (var session = new DesktopSession(Fixture(root, "forget"), "forget", Origin, null))
            Require(Complete(session.Run(delegate { })).Success);
    }
    private static void Failure(string root, string mode)
    {
        using (var session = new DesktopSession(Fixture(root, mode), "run", Origin, null))
        {
            DesktopResult result = Complete(session.Run(delegate { }));
            Require(result.Clean && !result.Success && !result.Stopped);
        }
    }
    private static void Lifecycle(string root, string mode)
    {
        string directory = Fixture(root, mode == "parent-death" ? "parent-death" : mode);
        DesktopSession session = null;
        Process host = null, companion = null, descendant = null;
        Task<DesktopResult> running = null;
        var connected = new ManualResetEvent(false);
        try
        {
            if (mode == "parent-death")
            {
                var start = new ProcessStartInfo(Application.ExecutablePath, "--parent \"" + directory + "\"");
                start.UseShellExecute = false; start.CreateNoWindow = true;
                host = Process.Start(start);
            }
            else
            {
                session = new DesktopSession(directory, "run", Origin, null);
                running = session.Run(delegate(string status) { if (status == "Connected") connected.Set(); });
                Require(connected.WaitOne(5000));
            }
            companion = Child(directory, "parent.pid"); descendant = Child(directory, "descendant.pid");
            Require(!companion.HasExited && !descendant.HasExited);
            if (host != null) { host.Kill(); Require(host.WaitForExit(5000)); }
            else
            {
                session.Stop();
                DesktopResult result = Complete(running);
                Require(result.Clean && result.Stopped);
                Require(result.Success == (mode == "eof"));
            }
            Require(companion.WaitForExit(3000)); Require(descendant.WaitForExit(3000));
        }
        finally
        {
            if (session != null) { session.Stop(); if (running != null) running.Wait(10000); session.Dispose(); }
            foreach (Process process in new[] { host, companion, descendant })
                if (process != null) { if (!process.HasExited) process.Kill(); process.WaitForExit(3000); process.Dispose(); }
            connected.Dispose();
        }
    }
    private static Process Child(string directory, string name)
    {
        string file = Path.Combine(directory, name);
        var watch = Stopwatch.StartNew();
        int pid;
        while (!File.Exists(file) || !int.TryParse(File.ReadAllText(file), out pid))
        {
            if (watch.ElapsedMilliseconds > 5000) throw new TimeoutException();
            Thread.Sleep(10);
        }
        var process = Process.GetProcessById(pid);
        Require(process.Handle != IntPtr.Zero); // Pin process identity before any termination.
        return process;
    }
    private static DesktopResult Complete(Task<DesktopResult> task) { Require(task.Wait(10000)); return task.Result; }
    private static void Reject(Action action) { bool rejected = false; try { action(); } catch { rejected = true; } Require(rejected); }
    private static void Require(bool value) { checks++; if (!value) throw new InvalidOperationException(); }
}
