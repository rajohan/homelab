using System;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Routes shell operations to the packaged shared modal, even when the dashboard is offline.
internal sealed class DesktopUpdateDialog
{
    private readonly Control background, content;
    private readonly DesktopDialogView view;
    private DesktopStateView fallback;
    private Button later, primary;
    private Control restoreFocus;
    private TaskCompletionSource<bool> choice;
    private string kind, title, detail;
    private int session, revision;
    internal bool IsOpen { get; private set; }
    internal event Action Closed;

    internal DesktopUpdateDialog(Control content, Control background, string directory)
    {
        this.content = content; this.background = background;
        view = new DesktopDialogView(Path.Combine(directory, "WebView2.LocalUI")) { Visible = false };
        view.Decision += delegate(string action) {
            if (!IsOpen) return;
            if (action == "dismiss:" + session) Dismiss();
            else if (action == "accept:" + revision) Accept();
        };
        view.Unavailable += UseFallback;
        content.Controls.Add(view);
    }
    private void Show(string type, string heading, string message)
    {
        bool opening = !IsOpen;
        if (opening) {
            session++;
            restoreFocus = content.FindForm().ActiveControl;
            IsOpen = true;
            background.Enabled = false;
        }
        kind = type; title = heading; detail = message; revision++;
        if (fallback != null) { PresentFallback(); return; }
        view.Show(); view.BringToFront();
        if (opening) view.Focus();
        view.Render(new JavaScriptSerializer().Serialize(new { session, revision, kind, title, detail }));
    }
    internal void Progress(string message, bool reveal = false)
    {
        if (IsOpen || reveal) Show("progress", message, "");
    }
    internal Task<bool> Confirm(string version, bool connected)
    {
        var pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        choice = pending;
        Show("offer", "Update to Homelab " + version + "?", connected
            ? "Current PC access will end. Homelab will reopen and reconnect this PC. Screen control will require fresh approval."
            : "Homelab will reopen with this PC disconnected.");
        return pending.Task;
    }
    internal void Notice(string heading, string message) { Show("notice", heading, message); }
    private void Accept()
    {
        if (choice == null || kind != "offer") return;
        var pending = choice; choice = null;
        Progress("Preparing update…", true);
        pending.TrySetResult(true);
    }
    internal void Dismiss()
    {
        if (!IsOpen) return;
        IsOpen = false; revision++;
        var pending = choice; choice = null;
        view.Hide();
        if (fallback == null) view.Render("null");
        else fallback.Hide();
        background.Enabled = true;
        if (restoreFocus != null && restoreFocus.CanFocus) restoreFocus.Focus();
        restoreFocus = null;
        if (pending != null) pending.TrySetResult(false);
        if (Closed != null) Closed();
    }

    // A PC without a working WebView2 runtime still needs a usable recovery screen.
    private void UseFallback()
    {
        if (fallback != null || content.IsDisposed) return;
        view.Hide();
        fallback = new DesktopStateView(true) { Visible = false };
        later = fallback.ActionButton("Later", false, delegate { Dismiss(); });
        primary = fallback.ActionButton("Done", true, delegate { if (kind == "offer") Accept(); else Dismiss(); });
        fallback.Click += delegate { Dismiss(); };
        content.Controls.Add(fallback);
        if (IsOpen) PresentFallback();
    }
    private void PresentFallback()
    {
        bool offer = kind == "offer";
        later.Visible = offer; primary.Text = offer ? "Update and reopen" : kind == "progress" ? "Hide" : "Done";
        fallback.Present(title, detail, kind == "notice" ? DesktopGlyph.Info : DesktopGlyph.Download);
        fallback.Show(); fallback.BringToFront();
        (offer ? later : primary).Select();
    }
    internal bool ProcessKey(Keys key)
    {
        if (!IsOpen || key != Keys.Escape) return false;
        Dismiss(); return true;
    }
}
