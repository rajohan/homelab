using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class DesktopUpdateTests
{
    private const string Origin = "https://mira.example.test";
    internal static byte[] Frame(byte[] bytes, string hash, int size, int validity)
    {
        string header = "{\"repository\":\"demo/homelab\",\"version\":\"0.11.0\",\"revision\":\"" + new string('a', 40) + "\",\"size\":" + size + ",\"sha256\":\"" + hash + "\",\"validForMs\":" + validity + "}\n";
        using (var stream = new MemoryStream()) {
            byte[] first = Encoding.ASCII.GetBytes(header);
            stream.Write(first, 0, first.Length); stream.Write(bytes, 0, bytes.Length); return stream.ToArray();
        }
    }
    internal static string Digest(byte[] bytes)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static void Refused(Action action, Action<bool> require)
    {
        bool rejected = false;
        try { action(); } catch (InvalidDataException) { rejected = true; } catch (IOException) { rejected = true; } catch (InvalidOperationException) { rejected = true; }
        require(rejected);
    }
    internal static void Run(string root, Action<bool> require)
    {
        string staging = Path.Combine(root, "update-staging"); Directory.CreateDirectory(staging);
        byte[] bytes = new byte[150000]; new Random(17).NextBytes(bytes);
        string hash = Digest(bytes);
        using (var stream = new MemoryStream(Frame(bytes, hash, bytes.Length, 60000)))
        using (var artifact = DesktopUpdateArtifact.Receive(stream, staging, Stopwatch.StartNew())) {
            require(artifact.Version == "0.11.0");
            string file = Path.Combine(Directory.GetDirectories(staging)[0], "setup.exe");
            require(Digest(File.ReadAllBytes(file)) == hash);
            Refused(delegate { using (var output = new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { } }, require);
            Refused(delegate { File.Delete(file); }, require);
        }
        require(Directory.GetDirectories(staging).Length == 0);
        foreach (var frame in new[] { Frame(bytes, new string('b', 64), bytes.Length, 60000), Frame(bytes, hash, bytes.Length + 1, 60000), Frame(bytes, hash, bytes.Length - 1, 60000), Frame(bytes, hash, bytes.Length, 0), Encoding.ASCII.GetBytes(new string('x', 1025)) }) {
            Refused(delegate { using (var stream = new MemoryStream(frame)) using (DesktopUpdateArtifact.Receive(stream, staging, Stopwatch.StartNew())) { } }, require);
            require(Directory.GetDirectories(staging).Length == 0);
        }
        var expired = Stopwatch.StartNew(); Thread.Sleep(10);
        Refused(delegate { using (var stream = new MemoryStream(Frame(bytes, hash, bytes.Length, 1))) using (DesktopUpdateArtifact.Receive(stream, staging, expired)) { } }, require);
        string fixture = Path.Combine(root, "fixture");
        foreach (string mode in new[] { "update-ok", "update-hash", "update-short", "update-extra", "update-failure", "update-hang" }) {
            File.WriteAllText(Path.Combine(fixture, "mode.txt"), mode);
            using (var session = new DesktopUpdateSession(fixture, Origin, staging)) {
                var pending = session.Run();
                if (mode == "update-hang") { Thread.Sleep(100); session.Stop(); }
                require(pending.Wait(6000));
                DesktopUpdateResult result = pending.Result;
                require(result.Clean);
                require((result.Artifact != null) == (mode == "update-ok"));
                if (result.Artifact != null) result.Artifact.Dispose();
            }
            require(Directory.GetDirectories(staging).Length == 0);
        }
        // This is an owned harmless executable mimicking setup; no real installation or desktop input.
        byte[] setup = File.ReadAllBytes(Path.Combine(fixture, "mira-computer.exe"));
        using (var stream = new MemoryStream(Frame(setup, Digest(setup), setup.Length, 60000)))
        using (var artifact = DesktopUpdateArtifact.Receive(stream, staging, Stopwatch.StartNew())) {
            var elapsed = Stopwatch.StartNew();
            require(artifact.Install());
            require(elapsed.ElapsedMilliseconds >= 300); // Wait for the descendant after its bootstrap exits.
        }
        require(Directory.GetDirectories(staging).Length == 0);
        string marker = Path.Combine(fixture, "installer-finished.txt");
        using (var process = WorkerJob.StartInstaller(Path.Combine(fixture, "mira-computer.exe"), fixture, new[] { "finish-root" })) {
            require(!process.StopAndConfirm());
        }
        var wait = Stopwatch.StartNew();
        while (!File.Exists(marker) && wait.ElapsedMilliseconds < 5000) Thread.Sleep(10);
        require(File.Exists(marker)); // Disposing the owner never kills committed setup.
        File.Delete(marker);
    }
}
