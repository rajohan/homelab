using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class DesktopSettings
{
    internal static string Origin(string value)
    {
        if (value == null || value.Length > 255 || !Regex.IsMatch(value, @"\Ahttps://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/?\z"))
            throw new ArgumentException("Enter the private HTTPS server address without a path.");
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Port < 1 || uri.Port > 65535 ||
            (uri.HostNameType != UriHostNameType.Dns && uri.HostNameType != UriHostNameType.IPv4))
            throw new ArgumentException("Enter a valid private HTTPS server address.");
        return uri.GetLeftPart(UriPartial.Authority).ToLowerInvariant();
    }

    internal static string PackageDirectory(string executable)
    {
        if (!Path.IsPathRooted(executable) || executable.StartsWith(@"\\") ||
            !string.Equals(Path.GetFileName(executable), "mira-computer-desktop.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        string directory = Path.GetDirectoryName(Path.GetFullPath(executable));
        var drive = new DriveInfo(Path.GetPathRoot(directory));
        if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable &&
            drive.DriveType != DriveType.Ram && drive.DriveType != DriveType.CDRom) throw new InvalidDataException();
        for (var parent = new DirectoryInfo(directory); parent != null; parent = parent.Parent)
            if ((parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        foreach (string name in new[] { "mira-computer-desktop.exe", "mira-computer.exe", "mira-computer-consent.exe", "mira-computer-worker-host.exe", "mira-computer-worker.exe" })
        {
            string file = Path.Combine(directory, name);
            if (!File.Exists(file) || (File.GetAttributes(file) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new InvalidDataException();
        }
        return directory;
    }

    internal static string Load(string directory)
    {
        string file = Path.Combine(directory, "server.txt");
        if (!File.Exists(file)) return "";
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || new FileInfo(file).Length > 512)
            throw new InvalidDataException();
        return Origin(File.ReadAllText(file, Encoding.UTF8).TrimEnd('\r', '\n'));
    }

    internal static void Save(string directory, string origin)
    {
        origin = Origin(origin);
        Directory.CreateDirectory(directory);
        for (var parent = new DirectoryInfo(directory); parent != null; parent = parent.Parent)
            if ((parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        string file = Path.Combine(directory, "server.txt");
        if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        string temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(origin);
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
