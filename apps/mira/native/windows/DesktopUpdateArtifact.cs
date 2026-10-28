using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using Homelab.Mira.Computer;

// A launcher-owned copy. The retained native read handle denies writes and deletion until setup completes.
internal sealed class DesktopUpdateArtifact : IDisposable
{
    private readonly string directory, file;
    private readonly Stopwatch clock;
    private readonly int validForMs;
    private FileStream retained;
    private bool installing, finished, disposed;
    internal readonly string Version;

    private DesktopUpdateArtifact(string owned, string version, Stopwatch started, int validity)
    {
        directory = owned; file = Path.Combine(owned, "setup.exe"); Version = version; clock = started; validForMs = validity;
    }

    internal static DesktopUpdateArtifact Receive(Stream input, string parent, Stopwatch clock)
    {
        var line = new StringBuilder();
        for (;;) {
            int value = input.ReadByte();
            if (value == 10) break;
            if (value < 32 || value > 126 || line.Length >= 1024) throw new InvalidDataException();
            line.Append((char)value);
        }
        var data = ConsentProtocol.Object(line.ToString());
        ConsentProtocol.Keys(data, "repository", "version", "revision", "size", "sha256", "validForMs");
        string version = ConsentProtocol.Text(data, "version", 14);
        string hash = ConsentProtocol.Text(data, "sha256", 64);
        if (!Regex.IsMatch(version, @"\A\d{1,4}\.\d{1,4}\.\d{1,4}\z") || !Regex.IsMatch(hash, @"\A[a-f0-9]{64}\z") ||
            !Regex.IsMatch(ConsentProtocol.Text(data, "repository", 201), @"\A[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\z") ||
            !Regex.IsMatch(ConsentProtocol.Text(data, "revision", 40), @"\A[a-f0-9]{40}\z")) throw new InvalidDataException();
        int size = Number(data, "size", 512 * 1024 * 1024), validity = Number(data, "validForMs", 300000);
        if (!Path.IsPathRooted(parent) || parent.StartsWith(@"\\")) throw new InvalidDataException();
        string directory = Path.Combine(parent, "mira-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var result = new DesktopUpdateArtifact(directory, version, clock, validity);
        try {
            result.RequireFresh();
            using (var output = new FileStream(result.file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                var buffer = new byte[65536];
                int remaining = size;
                while (remaining > 0) {
                    int read = input.Read(buffer, 0, Math.Min(buffer.Length, remaining));
                    if (read == 0) throw new EndOfStreamException();
                    result.RequireFresh();
                    output.Write(buffer, 0, read); remaining -= read;
                }
                if (input.ReadByte() != -1) throw new InvalidDataException();
                output.Flush(true);
            }
            // Open first and inspect/hash that exact handle; never trust a pathname checked before opening.
            var handle = CreateFile(result.file, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException(); }
            try {
                FileInformation info;
                if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & (0x400U | 0x10U)) != 0 || info.SizeHigh != 0 || info.SizeLow != size)
                    throw new InvalidDataException();
                result.retained = new FileStream(handle, FileAccess.Read);
            } catch { handle.Dispose(); throw; }
            using (var sha = SHA256.Create()) {
                string actual = BitConverter.ToString(sha.ComputeHash(result.retained)).Replace("-", "").ToLowerInvariant();
                if (actual != hash) throw new InvalidDataException();
            }
            result.RequireFresh();
            return result;
        } catch { result.Dispose(); throw; }
    }

    internal void RequireFresh()
    {
        if (clock.ElapsedMilliseconds >= validForMs) throw new InvalidDataException("Check for an update again; the download expired.");
    }

    internal bool Install()
    {
        RequireFresh();
        if (retained == null) throw new InvalidOperationException();
        using (var process = WorkerJob.StartInstaller(file, directory, new[] { "/CURRENTUSER", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-" })) {
            installing = true;
            bool success = process.FinishInstaller();
            finished = true;
            return success;
        }
    }

    private static int Number(Dictionary<string, object> data, string key, int maximum)
    {
        object value = data[key];
        if (!(value is int) || (int)value < 1 || (int)value > maximum) throw new InvalidDataException();
        return (int)value;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (retained != null) { retained.Dispose(); retained = null; }
        if (installing && !finished) return; // Uncertain setup may still need its executable.
        // Only the known file and empty directory owned by this operation are removed.
        File.Delete(file);
        Directory.Delete(directory, false);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
}
