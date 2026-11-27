using System;
using System.IO;

// Setup supplies a shortcut to the installed version with the fixed --startup argument.
internal static class DesktopStartup
{
    private static string Shortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup, Environment.SpecialFolderOption.DoNotVerify), "Homelab.lnk"); } }
    private static string Template { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Homelab", "MiraComputer", "Homelab startup.lnk"); } }
    internal static bool? Enabled { get { return File.Exists(Template) ? (bool?)File.Exists(Shortcut) : null; } }

    internal static void SetEnabled(bool enabled)
    {
        if (!File.Exists(Template)) throw new InvalidOperationException("Install Homelab for this Windows account to change startup.");
        if (enabled) {
            Directory.CreateDirectory(Path.GetDirectoryName(Shortcut));
            if (!File.Exists(Shortcut)) File.Copy(Template, Shortcut);
        } else if (File.Exists(Shortcut)) File.Delete(Shortcut);
    }
}
