using System.Drawing;
using System.Windows.Forms;

// Product-owned notices use the same frame as the shell and access picker.
internal sealed class MiraNotice : MiraWindow
{
    internal MiraNotice(string title, string message, string confirm = null)
    {
        Text = title; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(480, 230); MinimumSize = new Size(360, 210);
        MinimizeBox = false; MaximizeBox = false; ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var viewport = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Margin = new Padding(0, 0, 0, 16) };
        var text = new Label { Text = message, AutoSize = true, Location = Point.Empty };
        viewport.Controls.Add(text);
        viewport.Resize += delegate {
            text.MaximumSize = new Size(System.Math.Max(1, viewport.ClientSize.Width - SystemInformation.VerticalScrollBarWidth), 0);
        };
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        var done = ActionButton(confirm ?? "OK", DialogResult.OK);
        actions.Controls.Add(done); AcceptButton = done;
        if (confirm == null) CancelButton = done;
        else {
            done.BackColor = Accent; done.ForeColor = Canvas;
            var cancel = ActionButton("Later", DialogResult.Cancel);
            actions.Controls.Add(cancel); CancelButton = cancel;
        }
        layout.Controls.Add(viewport); layout.Controls.Add(actions);
        Content.Controls.Add(layout);
    }

    private static Button ActionButton(string text, DialogResult result)
    {
        var button = new DesktopButton { Text = text, AutoSize = true, Padding = new Padding(12, 4, 12, 4), FlatStyle = FlatStyle.Flat, BackColor = Raised, DialogResult = result };
        button.FlatAppearance.BorderColor = Border;
        return button;
    }

    internal static bool ConfirmUpdate(IWin32Window owner, string version, bool connected)
    {
        string message = "Mira " + version + " is ready to install. " + (connected
            ? "Current PC access will end. Mira will reopen and reconnect this PC. Screen control will require fresh approval."
            : "Mira will reopen with this PC disconnected.");
        using (var notice = new MiraNotice("Update Mira", message, "Update and reopen"))
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
