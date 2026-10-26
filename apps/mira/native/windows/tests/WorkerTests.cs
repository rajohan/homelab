using System;
using System.Diagnostics;
using System.IO;

internal static class WorkerTests
{
    private static int checks;
    private static int Main(string[] args)
    {
        if (args.Length != 1 || !Path.IsPathRooted(args[0])) return 1;
        try
        {
            foreach (string mode in new[] { "eof", "parent-death", "worker-exit" }) Check(args[0], mode);
            Console.WriteLine("Windows worker ownership: " + checks + " assertions passed.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Windows worker qualification failed after " + checks + ": " + error.GetType().Name); return 1; }
    }
    private static void Check(string host, string mode)
    {
        var start = new ProcessStartInfo(host);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.EnvironmentVariables["MIRA_QUALIFICATION_SECRET"] = "must-not-reach-worker";
        using (var supervisor = Process.Start(start))
        {
            Process worker = null, descendant = null;
            try
            {
                var reading = supervisor.StandardOutput.ReadLineAsync();
                Require(reading.Wait(5000));
                string[] metadata = (reading.Result ?? "").Split('|');
                Require(metadata.Length == 3 && metadata[2] == "filtered");
                worker = Process.GetProcessById(int.Parse(metadata[0]));
                descendant = Process.GetProcessById(int.Parse(metadata[1]));
                // Open handles now so PID reuse cannot change what the exit assertions observe.
                Require(worker.Handle != IntPtr.Zero && descendant.Handle != IntPtr.Zero);
                Require(!worker.HasExited && !descendant.HasExited);
                if (mode == "eof") supervisor.StandardInput.Close();
                else if (mode == "worker-exit") { supervisor.StandardInput.WriteLine("exit"); supervisor.StandardInput.Flush(); }
                else supervisor.Kill();
                Require(supervisor.WaitForExit(5000));
                if (mode != "parent-death") Require(supervisor.ExitCode == 0);
                Require(worker.WaitForExit(3000));
                Require(descendant.WaitForExit(3000));
            }
            finally
            {
                if (!supervisor.HasExited) supervisor.Kill();
                supervisor.WaitForExit(3000);
                if (worker != null) { if (!worker.HasExited) worker.Kill(); worker.Dispose(); }
                if (descendant != null) { if (!descendant.HasExited) descendant.Kill(); descendant.Dispose(); }
            }
        }
    }
    private static void Require(bool value)
    {
        checks++;
        if (!value) throw new InvalidOperationException();
    }
}
