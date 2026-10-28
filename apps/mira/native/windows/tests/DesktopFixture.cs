using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// A standalone fake companion. It never reads credentials, accesses a network, or captures input.
internal static class DesktopFixture
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "descendant")
        {
            File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "descendant.pid"), Process.GetCurrentProcess().Id.ToString());
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
            File.WriteAllText(Path.Combine(directory, "parent.pid"), Process.GetCurrentProcess().Id.ToString());
            Console.WriteLine("Connected. Press Ctrl+C to stop.");
            Console.Out.Flush();
            if (mode == "hang") Thread.Sleep(30000);
            else Console.In.ReadToEnd();
            return 0;
        }
    }
}
