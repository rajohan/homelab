using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

internal sealed class DesktopUpdateResult
{
    internal bool Clean;
    internal DesktopUpdateArtifact Artifact;
}

// Download and private pipe lifetime only. This child is never allowed to start an installer.
internal sealed class DesktopUpdateSession : IDisposable
{
    private readonly string package, origin, staging;
    private readonly ManualResetEvent stop = new ManualResetEvent(false);
    private int started;
    internal DesktopUpdateSession(string directory, string server, string temporaryParent)
    {
        if (!Path.IsPathRooted(directory) || !Path.IsPathRooted(temporaryParent)) throw new ArgumentException();
        package = directory; origin = DesktopSettings.Origin(server); staging = temporaryParent;
    }
    internal void Stop() { stop.Set(); }
    internal Task<DesktopUpdateResult> Run()
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException();
        return Task.Run((Func<DesktopUpdateResult>)Execute);
    }
    private DesktopUpdateResult Execute()
    {
        WorkerJob child = null;
        Thread output = null, error = null;
        var finished = new ManualResetEvent(false);
        var clock = Stopwatch.StartNew();
        DesktopUpdateArtifact artifact = null, offered = null;
        var receipt = new object();
        bool accepting = true;
        int failed = 0;
        bool clean = true, success = false;
        try {
            if (stop.WaitOne(0)) return new DesktopUpdateResult { Clean = true };
            clean = false;
            child = new WorkerJob(Path.Combine(package, "mira-computer.exe"), package, new[] { "download-update", origin, "--supervised" });
            Stream stdout = child.Output, stderr = child.Error;
            output = new Thread(delegate() {
                try {
                    var received = DesktopUpdateArtifact.Receive(stdout, staging);
                    lock (receipt) {
                        if (accepting) offered = received;
                        else received.Dispose();
                    }
                }
                catch { Interlocked.Exchange(ref failed, 1); }
                finally { try { finished.Set(); } catch (ObjectDisposedException) { } }
            });
            error = new Thread(delegate() {
                try { var buffer = new byte[4096]; while (stderr.Read(buffer, 0, buffer.Length) > 0) { } }
                catch { Interlocked.Exchange(ref failed, 1); }
            });
            output.IsBackground = error.IsBackground = true;
            output.Start(); error.Start();
            while (!stop.WaitOne(20) && clock.ElapsedMilliseconds < 300000 && !finished.WaitOne(0) && !child.Exited) { }
            child.Input.Dispose();
            var grace = Stopwatch.StartNew();
            while (!child.Exited && grace.ElapsedMilliseconds < 3000) Thread.Sleep(10);
            success = child.Exited && child.ExitCode == 0 && !stop.WaitOne(0) && clock.ElapsedMilliseconds < 300000;
        } catch { success = false; }
        finally {
            if (child != null) {
                clean = child.StopAndConfirm();
                if (output != null && !output.Join(1500)) clean = false;
                if (error != null && !error.Join(1500)) clean = false;
                child.Dispose();
            }
            lock (receipt) { accepting = false; artifact = offered; offered = null; }
            finished.Dispose();
        }
        if (!clean || !success || Volatile.Read(ref failed) != 0) {
            if (artifact != null) artifact.Dispose();
            artifact = null;
        }
        if (artifact != null) {
            try { artifact.RequireFresh(); }
            catch { artifact.Dispose(); artifact = null; }
        }
        return new DesktopUpdateResult { Clean = clean, Artifact = artifact };
    }
    public void Dispose() { stop.Dispose(); }
}
