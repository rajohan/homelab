using System;
using System.Diagnostics;
using System.Reflection;
using System.Threading;

// Qualification only. It never loads the SDK or accesses an interactive window.
internal static class WorkerFixture
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--descendant") { Thread.Sleep(Timeout.Infinite); return 0; }
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--descendant");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        using (var child = Process.Start(start))
        {
            Console.WriteLine(Process.GetCurrentProcess().Id + "|" + child.Id + "|" +
                (Environment.GetEnvironmentVariable("MIRA_QUALIFICATION_SECRET") == null ? "filtered" : "leaked"));
            Console.Out.Flush();
            string line = Console.ReadLine();
            if (line == "exit") return 0;
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
    }
}
