using System.Drawing;
using System.Windows.Forms;

// Product-owned notices use the same frame as the shell and access picker.
internal sealed class MiraNotice : MiraWindow
{
    internal MiraNotice(string title, string message)
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
        var done = new Button { Text = "OK", AutoSize = true, Anchor = AnchorStyles.Right, Padding = new Padding(16, 6, 16, 6), FlatStyle = FlatStyle.Flat, BackColor = Raised, DialogResult = DialogResult.OK };
        layout.Controls.Add(viewport); layout.Controls.Add(done);
        Content.Controls.Add(layout); AcceptButton = done; CancelButton = done;
    }

    internal static void ShowNotice(IWin32Window owner, string message, string title)
    {
        using (var notice = new MiraNotice(title, message)) {
            if (owner == null) notice.StartPosition = FormStartPosition.CenterScreen;
            notice.ShowDialog(owner);
        }
    }
}
