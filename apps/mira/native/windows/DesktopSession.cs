using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal sealed class DesktopResult
{
    internal bool Clean;
    internal bool Success;
    internal bool Stopped;
}

// The visible launcher owns the companion and its entire native process tree.
internal sealed class DesktopSession : IDisposable
{
    private readonly ManualResetEvent stop = new ManualResetEvent(false);
    private readonly string directory, operation, origin;
    private string ticket;
    private int started;
    private int disposed;

    internal DesktopSession(string package, string command, string server, string pairing)
    {
        if (command != "run" && command != "pair" && command != "forget") throw new ArgumentException();
        if (!Path.IsPathRooted(package)) throw new ArgumentException();
        if (command == "pair" && (pairing == null || !Regex.IsMatch(pairing, @"\Amira_pair_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\z")))
            throw new ArgumentException("Paste the pairing code from Settings > Computers.");
        if (command != "pair" && !string.IsNullOrEmpty(pairing)) throw new ArgumentException();
        directory = package; operation = command; origin = DesktopSettings.Origin(server); ticket = pairing;
    }

    internal void Stop() { if (Volatile.Read(ref disposed) == 0) stop.Set(); }

    internal Task<DesktopResult> Run(Action<string> status)
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException();
        return Task.Run(delegate { return Execute(status); });
    }

    private DesktopResult Execute(Action<string> status)
    {
        WorkerJob child = null;
        var pipeLost = new ManualResetEvent(false);
        bool success = false, clean = true;
        int failed = 0;
        Thread stdout = null, stderr = null;
        try
        {
            if (stop.WaitOne(0)) return new DesktopResult { Clean = true, Stopped = true };
            string[] arguments = operation == "run" ? new[] { operation, origin, "--supervised" } : new[] { operation, origin };
            clean = false;
            child = new WorkerJob(Path.Combine(directory, "mira-computer.exe"), directory, arguments);
            var output = child.Output;
            var error = child.Error;
            stdout = StartReader(delegate
            {
                using (var reader = new StreamReader(output, new UTF8Encoding(false, true), false, 1024, true))
                {
                    var line = new StringBuilder();
                    for (;;)
                    {
                        int character = reader.Read();
                        if (character < 0) break;
                        if (character == 10)
                        {
                            string message = line.ToString().TrimEnd('\r');
                            line.Clear();
                            if (message == "Connected. Press Ctrl+C to stop.") status("Connected");
                            if (message == "Connection interrupted. Retrying in 30 seconds.") status("Reconnecting");
                        }
                        else { if (line.Length >= 1024) throw new InvalidDataException(); line.Append((char)character); }
                    }
                }
            }, pipeLost, delegate { Interlocked.Exchange(ref failed, 1); });
            stderr = StartReader(delegate { byte[] buffer = new byte[4096]; while (error.Read(buffer, 0, buffer.Length) > 0) { } }, pipeLost, delegate { Interlocked.Exchange(ref failed, 1); });
            if (operation == "pair")
            {
                byte[] bytes = Encoding.ASCII.GetBytes(ticket + "\n");
                ticket = null;
                try { child.Input.Write(bytes, 0, bytes.Length); child.Input.Flush(); }
                finally { Array.Clear(bytes, 0, bytes.Length); }
            }
            while (!stop.WaitOne(20) && !pipeLost.WaitOne(0) && !child.Exited) { }
            // EOF aborts the supervised run and joins its existing controller cleanup.
            child.Input.Dispose();
            var grace = Stopwatch.StartNew();
            while (!child.Exited && grace.ElapsedMilliseconds < 3000) Thread.Sleep(10);
            success = child.Exited && child.ExitCode == 0;
        }
        catch { success = false; }
        finally
        {
            ticket = null;
            if (child != null)
            {
                clean = child.StopAndConfirm();
                // Join the finite pipe readers after every owned process has stopped.
                if (stdout != null && !stdout.Join(1500)) clean = false;
                if (stderr != null && !stderr.Join(1500)) clean = false;
                child.Dispose();
            }
            // Readers may still be leaving their pipes; their completion catches disposal.
            pipeLost.Dispose();
        }
        return new DesktopResult { Clean = clean, Success = success && clean && Volatile.Read(ref failed) == 0, Stopped = stop.WaitOne(0) };
    }

    private static Thread StartReader(Action read, ManualResetEvent completed, Action failed)
    {
        var thread = new Thread(delegate()
        {
            try { read(); } catch { failed(); }
            finally { try { completed.Set(); } catch (ObjectDisposedException) { } }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        stop.Dispose();
    }
}
