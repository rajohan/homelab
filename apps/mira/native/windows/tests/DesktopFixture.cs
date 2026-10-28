using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Threading;

// A standalone fake companion. It never reads credentials, accesses a network, or captures input.
internal static class DesktopFixture
{
    private static void PublishPid(string name)
    {
        string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name);
        // Readers must never see a PID file while its exclusive writer is still open.
        File.WriteAllText(file + ".tmp", Process.GetCurrentProcess().Id.ToString());
        File.Move(file + ".tmp", file);
    }
    private static int Main(string[] args)
    {
        if (args.Length > 0 && (args[0] == "finish-root" || args[0] == "/CURRENTUSER")) {
            string next = args[0] == "finish-root" ? "finish-child" : "finish-child-no-file";
            using (Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, next) { UseShellExecute = false, CreateNoWindow = true })) { }
            return 0;
        }
        if (args.Length == 1 && (args[0] == "finish-child" || args[0] == "finish-child-no-file")) {
            Thread.Sleep(400);
            if (args[0] == "finish-child") File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer-finished.txt"), "finished");
            return 0;
        }
        if (args.Length == 1 && args[0] == "descendant")
        {
            PublishPid("descendant.pid");
            Thread.Sleep(30000); return 0;
        }
        if (args.Length > 0 && args[0] == "echo")
        {
            foreach (string value in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
            return 0;
        }
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string mode = File.ReadAllText(Path.Combine(directory, "mode.txt"));
        if (args.Length < 2 || args[1] != "https://mira.example.test") return 2;
        if (args[0] == "download-update") {
            if (args.Length != 3 || args[2] != "--supervised") return 9;
            if (mode == "update-hang") { Console.In.ReadToEnd(); return 1; }
            var bytes = new byte[150000]; new Random(17).NextBytes(bytes);
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            if (mode == "update-hash") hash = new string('b', 64);
            Console.Write("{\"repository\":\"demo/homelab\",\"version\":\"0.11.0\",\"revision\":\"" + new string('a', 40) + "\",\"size\":" + bytes.Length + ",\"sha256\":\"" + hash + "\",\"validForMs\":60000}\n");
            Console.Out.Flush();
            var output = Console.OpenStandardOutput();
            output.Write(bytes, 0, mode == "update-short" ? 10 : bytes.Length);
            if (mode == "update-extra") output.WriteByte(17);
            output.Flush();
            return mode == "update-failure" ? 1 : 0;
        }
        if (mode == "pair")
        {
            if (args.Length != 2 || args[0] != "pair") return 3;
            string ticket = Console.ReadLine();
            File.WriteAllText(Path.Combine(directory, "pair-result.txt"), ticket == "mira_pair_12345678-1234-1234-1234-123456789abc." + new string('A', 43) ? "private-stdin" : "invalid");
            return 0;
        }
        if (mode == "forget") return args.Length == 2 && args[0] == "forget" ? 0 : 4;
        if (args.Length != 3 || args[0] != "run" || args[2] != "--supervised") return 5;
        if (mode == "failure") return 7;
        if (mode == "oversize") { Console.WriteLine(new string('x', 2048)); return 0; }
        using (var descendant = new WorkerJob(Process.GetCurrentProcess().MainModule.FileName, directory, new[] { "descendant" }))
        {
            // The descendant identifies itself through a second dedicated fixture mode.
            PublishPid("parent.pid");
            Console.WriteLine("Connected. Press Ctrl+C to stop.");
            Console.Out.Flush();
            if (mode == "hang") Thread.Sleep(30000);
            else Console.In.ReadToEnd();
            return 0;
        }
    }
}
