using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

// Child controls of the actual app window, including when WebView2 is loading or offline.
// Only the native button can confirm installing a downloaded artifact.
internal sealed class DesktopUpdateDialog
{
    private sealed class Backdrop : Panel
    {
        [DllImport("user32.dll")]
        private static extern bool SetLayeredWindowAttributes(IntPtr window, uint color, byte alpha, uint flags);
        protected override CreateParams CreateParams
        {
            get { var style = base.CreateParams; style.ExStyle |= 0x80000; return style; } // WS_EX_LAYERED
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            SetLayeredWindowAttributes(Handle, 0, 160, 2); // LWA_ALPHA, also over a child WebView HWND.
        }
    }

    private readonly Control background;
    private readonly Backdrop shade = new Backdrop { Dock = DockStyle.Fill, BackColor = Color.Black, Visible = false };
    private readonly DesktopStateView panel = new DesktopStateView(true, true) { Visible = false, AccessibleRole = AccessibleRole.Dialog };
    private readonly Button later, primary;
    private Control restoreFocus;
    private TaskCompletionSource<bool> choice;
    internal bool IsOpen { get; private set; }

    internal DesktopUpdateDialog(Control content, Control background)
    {
        this.background = background;
        later = panel.ActionButton("Later", false, delegate { Dismiss(); });
        primary = panel.ActionButton("Done", true, delegate {
            if (choice == null) { Dismiss(); return; }
            var pending = choice; choice = null;
            Progress("Preparing update…", true);
            pending.TrySetResult(true);
        });
        content.Controls.Add(shade); content.Controls.Add(panel);
    }

    private void Show(string title, string detail, DesktopGlyph icon, string action, bool offer)
    {
        bool opening = !IsOpen;
        if (opening) {
            restoreFocus = background.FindForm().ActiveControl;
            IsOpen = true; background.Enabled = false;
            shade.Show(); shade.BringToFront(); panel.Show(); panel.BringToFront();
        }
        later.Visible = offer; primary.Text = action;
        panel.Present(title, detail, icon);
        if (opening || offer || !panel.ContainsFocus) {
            FocusButton(offer ? later : primary);
        }
    }
    internal void Progress(string message, bool reveal = false)
    {
        if (IsOpen || reveal) Show(message, "", DesktopGlyph.Download, "Hide", false);
    }
    internal Task<bool> Confirm(string version, bool connected)
    {
        var pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        choice = pending;
        Show("Update to Homelab " + version + "?", connected
            ? "Current PC access will end. Homelab will reopen and reconnect this PC. Screen control will require fresh approval."
            : "Homelab will reopen with this PC disconnected.", DesktopGlyph.Download, "Update and reopen", true);
        return pending.Task;
    }
    internal void Notice(string title, string description)
    {
        Show(title, description, DesktopGlyph.Info, "Done", false);
    }
    internal void Dismiss()
    {
        if (!IsOpen) return;
        IsOpen = false;
        var pending = choice; choice = null;
        panel.Hide(); shade.Hide(); background.Enabled = true;
        if (restoreFocus != null && restoreFocus.CanFocus) restoreFocus.Focus();
        else if (background.CanFocus) background.Focus();
        restoreFocus = null;
        if (pending != null) pending.TrySetResult(false);
    }
    internal bool ProcessKey(Keys key)
    {
        if (!IsOpen) return false;
        if (key == Keys.Escape) { Dismiss(); return true; }
        if (key == Keys.Tab || key == (Keys.Shift | Keys.Tab)) {
            FocusButton(later.Visible && panel.FindForm().ActiveControl != later ? later : primary);
            return true;
        }
        return false;
    }
    private void FocusButton(Button button)
    {
        panel.FindForm().ActiveControl = button;
        button.Select();
    }
}
