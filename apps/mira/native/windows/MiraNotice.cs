using System.Drawing;
using System.Windows.Forms;

// Product-owned notices use the same frame as the shell and access picker.
internal sealed class MiraNotice : MiraWindow
{
    private MiraNotice(string title, string message)
    {
        Text = "Homelab"; AccessibleName = title; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(440, 285); MinimumSize = new Size(335, 230);
        MinimizeBox = false; MaximizeBox = false; ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        var state = new DesktopStateView(false);
        var done = state.ActionButton("Done", true, null);
        done.DialogResult = DialogResult.OK; AcceptButton = done;
        CancelButton = done;
        state.Present(title, message, DesktopGlyph.Info);
        Content.Controls.Add(state);
    }

    internal static void ShowNotice(IWin32Window owner, string message, string title)
    {
        using (var notice = new MiraNotice(title, message)) {
            if (owner == null) notice.StartPosition = FormStartPosition.CenterScreen;
            notice.ShowDialog(owner);
        }
    }
}
