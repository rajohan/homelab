using System.Drawing;
using System.Windows.Forms;

// Product-owned notices use the same frame as the shell and access picker.
internal sealed class MiraNotice : MiraWindow
{
    internal MiraNotice(string title, string message, string confirm = null)
    {
        Text = "Homelab"; AccessibleName = title; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(440, 285); MinimumSize = new Size(335, 230);
        MinimizeBox = false; MaximizeBox = false; ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        var state = new DesktopStateView(false);
        if (confirm != null) {
            var later = state.ActionButton("Later", false, null);
            later.DialogResult = DialogResult.Cancel; CancelButton = later;
        }
        var done = state.ActionButton(confirm ?? "Done", true, null);
        done.DialogResult = DialogResult.OK; AcceptButton = done;
        if (confirm == null) CancelButton = done;
        state.Present(title, message, confirm == null ? DesktopGlyph.Info : DesktopGlyph.Download);
        Content.Controls.Add(state);
    }

    internal static bool ConfirmUpdate(IWin32Window owner, string version, bool connected)
    {
        string message = connected
            ? "Current PC access will end. Homelab will reopen and reconnect this PC. Screen control will require fresh approval."
            : "Homelab will reopen with this PC disconnected.";
        using (var notice = new MiraNotice("Update to Homelab " + version + "?", message, "Update and reopen"))
            return notice.ShowDialog(owner) == DialogResult.OK;
    }

    internal static void ShowNotice(IWin32Window owner, string message, string title)
    {
        using (var notice = new MiraNotice(title, message)) {
            if (owner == null) notice.StartPosition = FormStartPosition.CenterScreen;
            notice.ShowDialog(owner);
        }
    }
}
