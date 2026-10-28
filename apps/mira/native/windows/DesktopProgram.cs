using System;
using System.IO;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal static class DesktopProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool check = args.Length == 1 && args[0] == "--check-package";
        bool leaseOnly = args.Length == 1 && args[0] == "--installation-lease";
        if ((!check && !leaseOnly && args.Length != 0) || !Environment.Is64BitProcess || Environment.OSVersion.Version.Major < 10) return 1;
        try
        {
            if (check) { DesktopSettings.PackageDirectory(Application.ExecutablePath); return 0; }
            if (leaseOnly) return InstallationProtocol.Run(InstallationLease.DirectoryPath);
            FileStream lease = InstallationLease.Open(InstallationLease.DirectoryPath, false);
            try
            {
                using (var identity = WindowsIdentity.GetCurrent())
                {
                    string directory = DesktopSettings.PackageDirectory(Application.ExecutablePath);
                    if (!Environment.UserInteractive || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                        throw new InvalidOperationException("Start Mira in your normal Windows session without administrator privileges.");
                    bool created;
                    using (var instance = new Mutex(true, @"Global\Homelab.Mira.Computer.Desktop." + identity.User.Value, out created))
                    {
                        if (!created) { MessageBox.Show("Mira is already running for this Windows account.", "Mira"); return 1; }
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        string settings = InstallationLease.DirectoryPath;
                        using (var form = new DesktopForm(directory, settings, delegate(bool release) {
                            if (release) { if (lease != null) lease.Dispose(); lease = null; }
                            else if (lease == null) lease = InstallationLease.Open(settings, false);
                        })) Application.Run(form);
                    }
                }
            } finally { if (lease != null) lease.Dispose(); }
            return 0;
        }
        catch
        {
            if (!check && !leaseOnly) MessageBox.Show("Mira could not start. Wait for any installation to finish, then use the complete local package in your normal Windows session without administrator privileges.", "Mira", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
