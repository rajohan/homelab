using System;
using System.IO;

// Shared runtime readers exclude the installer's exclusive handle for the whole operation.
internal static class InstallationLease
{
    internal static string DirectoryPath
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Homelab", "MiraComputer"); }
    }

    internal static FileStream Open(string directory, bool maintenance)
    {
        if (!Path.IsPathRooted(directory) || directory.StartsWith(@"\\")) throw new InvalidDataException();
        directory = Path.GetFullPath(directory);
        if (new DriveInfo(Path.GetPathRoot(directory)).DriveType != DriveType.Fixed) throw new InvalidDataException();
        for (var parent = new DirectoryInfo(directory); parent != null; parent = parent.Parent)
            if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "installation.lock");
        if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        return new FileStream(file, FileMode.OpenOrCreate, maintenance ? FileAccess.ReadWrite : FileAccess.Read,
            maintenance ? FileShare.None : FileShare.Read);
    }
}
