using System;
using System.IO;
using System.Threading;

internal static class WorkerProgram
{
    // The product host has no command-line or environment-selected executable.
    private static int Main(string[] args)
    {
        if (args.Length != 0 || !Environment.Is64BitProcess || Environment.OSVersion.Version.Major < 10 ||
            !Console.IsInputRedirected || !Console.IsOutputRedirected) return 1;
        try
        {
            string directory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string executable = Path.Combine(directory, "mira-computer-worker.exe");
            if (!File.Exists(executable)) return 1;
            using (var hardDeadline = new Timer(delegate { Environment.Exit(2); }, null, 301000, Timeout.Infinite))
            using (var worker = new WorkerJob(executable, directory))
            using (var stopped = new ManualResetEvent(false))
            using (var lifetime = new Timer(delegate { stopped.Set(); }, null, 300000, Timeout.Infinite))
            {
                Pump(Console.OpenStandardInput(), worker.Input, 32768, stopped);
                Pump(worker.Output, Console.OpenStandardOutput(), 4 * 1024 * 1024, stopped);
                // Diagnostics are never forwarded: the Bun parent receives content-free failures.
                Pump(worker.Error, Stream.Null, 65536, stopped);
                while (!stopped.WaitOne(20) && !worker.Exited) { }
                return worker.StopAndConfirm() ? 0 : 2;
            }
        }
        catch { return 1; }
    }

    private static void Pump(Stream source, Stream destination, int frameLimit, ManualResetEvent stopped)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                byte[] buffer = new byte[4096];
                int frameSize = 0;
                while (true)
                {
                    int count = source.Read(buffer, 0, buffer.Length);
                    if (count == 0) break;
                    for (int i = 0; i < count; i++)
                    {
                        if (++frameSize > frameLimit) throw new InvalidDataException();
                        if (buffer[i] == 10) frameSize = 0;
                    }
                    if (stopped.WaitOne(0)) break;
                    destination.Write(buffer, 0, count);
                    destination.Flush();
                }
            }
            catch { }
            finally { try { stopped.Set(); } catch (ObjectDisposedException) { } }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
