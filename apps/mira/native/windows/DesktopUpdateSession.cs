using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Homelab.Mira.Computer;

internal sealed class DesktopUpdateResult
{
    internal bool Clean;
    internal bool UpToDate;
    internal string AvailableVersion;
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
    internal Task<DesktopUpdateResult> Run(bool checkOnly = false)
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException();
        return Task.Run(delegate { return Execute(checkOnly); });
    }
    private static string ReadVersion(Stream input)
    {
        string header = DesktopUpdateArtifact.ReadHeader(input);
        if (input.ReadByte() != -1) throw new InvalidDataException();
        if (header == "{\"status\":\"current\"}") return null;
        var data = ConsentProtocol.Object(header);
        ConsentProtocol.Keys(data, "version");
        string version = ConsentProtocol.Text(data, "version", 14);
        if (!Regex.IsMatch(version, @"\A[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}\z")) throw new InvalidDataException();
        return version;
    }
    private DesktopUpdateResult Execute(bool checkOnly)
    {
        WorkerJob child = null;
        Thread output = null, error = null;
        var finished = new ManualResetEvent(false);
        var clock = Stopwatch.StartNew();
        DesktopUpdateArtifact artifact = null, offered = null;
        string availableVersion = null;
        int timeout = checkOnly ? 30000 : 300000;
        var receipt = new object();
        bool accepting = true;
        int failed = 0;
        bool clean = true, success = false;
        try {
            if (stop.WaitOne(0)) return new DesktopUpdateResult { Clean = true };
            clean = false;
            child = new WorkerJob(Path.Combine(package, "mira-computer.exe"), package, new[] { checkOnly ? "check-update" : "download-update", origin, "--supervised" });
            Stream stdout = child.Output, stderr = child.Error;
            output = new Thread(delegate() {
                try {
                    if (checkOnly) { availableVersion = ReadVersion(stdout); return; }
                    var received = DesktopUpdateArtifact.Receive(stdout, staging);
                    lock (receipt) {
                        if (accepting) offered = received;
                        else if (received != null) received.Dispose();
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
            while (!stop.WaitOne(20) && clock.ElapsedMilliseconds < timeout && !finished.WaitOne(0) && !child.Exited) { }
            child.Input.Dispose();
            var grace = Stopwatch.StartNew();
            while (!child.Exited && grace.ElapsedMilliseconds < 3000) Thread.Sleep(10);
            success = child.Exited && child.ExitCode == 0 && !stop.WaitOne(0) && clock.ElapsedMilliseconds < timeout;
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
        bool valid = clean && success && Volatile.Read(ref failed) == 0;
        bool upToDate = valid && artifact == null && availableVersion == null;
        if (!valid) {
            if (artifact != null) artifact.Dispose();
            artifact = null;
        }
        if (artifact != null) {
            try { artifact.RequireFresh(); }
            catch { artifact.Dispose(); artifact = null; }
        }
        return new DesktopUpdateResult { Clean = clean, UpToDate = upToDate, Artifact = artifact, AvailableVersion = valid ? availableVersion : null };
    }
    public void Dispose() { stop.Dispose(); }
}
