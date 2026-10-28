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
        if ((!check && args.Length != 0) || !Environment.Is64BitProcess || Environment.OSVersion.Version.Major < 10) return 1;
        try
        {
            string directory = DesktopSettings.PackageDirectory(Application.ExecutablePath);
            if (check) return 0;
            using (var identity = WindowsIdentity.GetCurrent())
            {
                if (!Environment.UserInteractive || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Start Mira in your normal Windows session without administrator privileges.");
                bool created;
                using (var instance = new Mutex(true, @"Global\Homelab.Mira.Computer.Desktop." + identity.User.Value, out created))
                {
                    if (!created) { MessageBox.Show("Mira is already running for this Windows account.", "Mira"); return 1; }
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Homelab", "MiraComputer");
                    using (var form = new DesktopForm(directory, settings)) Application.Run(form);
                }
            }
            return 0;
        }
        catch
        {
            if (!check) MessageBox.Show("Mira could not start. Use the complete local package in your normal Windows session, without administrator privileges.", "Mira", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
