using System.Drawing;
using System.Windows.Forms;

// Product-owned notices use the same frame as the shell and access picker.
internal sealed class MiraNotice : MiraWindow
{
    private readonly DesktopUpdateDialog dialog;
    private MiraNotice(string title, string message)
    {
        Text = "Homelab"; AccessibleName = title; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(640, 400); MinimumSize = new Size(355, 290);
        MinimizeBox = false; MaximizeBox = false; ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        var background = new Panel { Dock = DockStyle.Fill, BackColor = Canvas };
        Content.Controls.Add(background);
        dialog = new DesktopUpdateDialog(Content, background, InstallationLease.DirectoryPath);
        dialog.Closed += Close;
        Shown += delegate { dialog.Notice(title, message); };
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        return (dialog != null && dialog.ProcessKey(keyData)) || base.ProcessCmdKey(ref msg, keyData);
    }

    internal static void ShowNotice(IWin32Window owner, string message, string title)
    {
        using (var notice = new MiraNotice(title, message)) {
            if (owner == null) notice.StartPosition = FormStartPosition.CenterScreen;
            notice.ShowDialog(owner);
        }
    }
}
