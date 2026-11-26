using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Homelab")]
[assembly: AssemblyProduct("Homelab")]
[assembly: AssemblyDescription("Homelab dashboard for Windows")]

internal static class DesktopProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool check = args.Length == 1 && args[0] == "--check-package";
        bool startup = args.Length == 1 && args[0] == "--startup";
        bool disconnected = args.Length == 1 && args[0] == "--updated-disconnected";
        bool leaseOnly = args.Length == 1 && args[0] == "--installation-lease";
        if ((!check && !leaseOnly && !startup && !disconnected && args.Length != 0) || !Environment.Is64BitProcess || Environment.OSVersion.Version.Major < 10) return 1;
        try
        {
            if (check) { DesktopSettings.PackageDirectory(Application.ExecutablePath); return 0; }
            if (leaseOnly) return InstallationProtocol.Run(InstallationLease.DirectoryPath);
            FileStream lease = InstallationLease.Open(InstallationLease.DirectoryPath, false);
            string installedVersion = null;
            bool reconnect = false;
            try
            {
                using (var identity = WindowsIdentity.GetCurrent())
                {
                    string directory = DesktopSettings.PackageDirectory(Application.ExecutablePath);
                    if (!Environment.UserInteractive || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                        throw new InvalidOperationException("Start Homelab in your normal Windows session without administrator privileges.");
                    bool created;
                    using (var instance = new Mutex(true, @"Global\Homelab.Mira.Computer.Desktop." + identity.User.Value, out created))
                    {
                        if (!created) { if (!startup) MiraNotice.ShowNotice(null, "Homelab is already running for this Windows account.", "Homelab"); return 1; }
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        string settings = InstallationLease.DirectoryPath;
                        using (var form = new DesktopForm(directory, settings, delegate(bool release) {
                            if (release) { if (lease != null) lease.Dispose(); lease = null; }
                            else if (lease == null) lease = InstallationLease.Open(settings, false);
                        }, startup, !disconnected)) {
                            Application.Run(form);
                            installedVersion = form.InstalledVersion;
                            reconnect = form.ReconnectAfterUpdate;
                        }
                    }
                }
            } finally { if (lease != null) lease.Dispose(); }
            if (installedVersion != null) {
                // Setup installs side by side. Start only its verified version in the fixed per-user Programs tree,
                // after releasing the old single-instance mutex and disposing this process's WebView.
                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs", "Homelab", "MiraComputer", "versions", installedVersion);
                string executable = Path.Combine(directory, "mira-computer-desktop.exe");
                try {
                    DesktopSettings.PackageDirectory(executable);
                    using (Process.Start(new ProcessStartInfo(executable, reconnect ? "" : "--updated-disconnected") {
                        WorkingDirectory = directory, UseShellExecute = false
                    })) { }
                } catch {
                    MiraNotice.ShowNotice(null, "Homelab was updated. Open Homelab from Start to use the new version.", "Update installed");
                }
            }
            return 0;
        }
        catch
        {
            if (!check && !leaseOnly && !startup) MiraNotice.ShowNotice(null, "Homelab could not start. Wait for any installation to finish, then use the complete local package in your normal Windows session without administrator privileges.", "Homelab");
            return 1;
        }
    }
}
