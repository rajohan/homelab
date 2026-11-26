using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// The WebView may be unavailable while the PC is offline. These local states share
// the dashboard's card, heading, button and surface treatment with update notices.
internal sealed class DesktopStateView : Panel
{
    private readonly Panel card = new Panel();
    private readonly Panel symbol = new Panel();
    private readonly Label heading = new Label(), detail = new Label();
    private readonly FlowLayoutPanel actions = new FlowLayoutPanel();
    private readonly bool embedded;
    private readonly Font headingFont;
    private DesktopGlyph glyph;
    private bool arranging;

    internal DesktopStateView(bool framedCard)
    {
        embedded = framedCard;
        Dock = DockStyle.Fill; BackColor = MiraWindow.Canvas; AutoScroll = true;
        card.BackColor = framedCard ? MiraWindow.Surface : MiraWindow.Canvas;
        headingFont = new Font("Segoe UI", framedCard ? 18 : 15, FontStyle.Bold);
        heading.Font = headingFont; heading.ForeColor = MiraWindow.TextColor;
        heading.TextAlign = ContentAlignment.MiddleLeft;
        detail.ForeColor = MiraWindow.Muted;
        heading.UseMnemonic = detail.UseMnemonic = false;
        symbol.Paint += delegate(object sender, PaintEventArgs e) {
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = DesktopAppearance.Round(new Rectangle(0, 0, symbol.Width - 1, symbol.Height - 1), Px(9)))
            using (var fill = new SolidBrush(MiraWindow.Raised)) g.FillPath(fill, path);
            DesktopAppearance.Glyph(g, glyph, Rectangle.Inflate(symbol.ClientRectangle, -Px(8), -Px(8)), MiraWindow.Accent);
        };
        if (framedCard) card.Paint += delegate(object sender, PaintEventArgs e) {
            e.Graphics.Clear(MiraWindow.Canvas); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = DesktopAppearance.Round(new Rectangle(0, 0, card.Width - 1, card.Height - 1), Px(10)))
            using (var fill = new SolidBrush(MiraWindow.Surface))
            using (var p = new Pen(MiraWindow.Border)) { e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(p, path); }
        };
        actions.AutoSize = true; actions.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        actions.WrapContents = true;
        card.Controls.AddRange(new Control[] { symbol, heading, detail, actions });
        Controls.Add(card);
    }
    internal Button ActionButton(string label, bool primary, EventHandler clicked)
    {
        var button = new DesktopButton {
            Text = label, Primary = primary, AutoSize = true, MinimumSize = new Size(Px(84), Px(36)),
            Padding = new Padding(Px(12), Px(3), Px(12), Px(3)), Margin = new Padding(0, 0, Px(6), Px(4))
        };
        if (clicked != null) button.Click += clicked;
        actions.Controls.Add(button);
        button.VisibleChanged += delegate { PerformLayout(); };
        return button;
    }
    internal void Present(string title, string description, DesktopGlyph icon)
    {
        heading.Text = title; detail.Text = description; glyph = icon;
        AccessibleName = title; symbol.Invalidate(); PerformLayout();
    }
    private int Px(int value) { return (int)Math.Round(value * DeviceDpi / 96.0); }
    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        if (arranging || card == null || card.Parent == null || ClientSize.Width < 1) return;
        arranging = true;
        try {
            int edge = embedded ? Px(16) : 0, pad = Px(embedded ? 25 : 18);
            int width = Math.Max(Px(150), Math.Min(ClientSize.Width - edge * 2, embedded ? Px(440) : ClientSize.Width));
            int inner = Math.Max(1, width - pad * 2);
            int y = pad, iconSize = Px(embedded ? 36 : 32), titleOffset = iconSize + Px(10);
            var flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl;
            int titleWidth = Math.Max(1, inner - titleOffset);
            int titleHeight = TextRenderer.MeasureText(heading.Text, heading.Font, new Size(titleWidth, int.MaxValue), flags).Height;
            int headerHeight = Math.Max(iconSize, titleHeight);
            symbol.SetBounds(pad, y + (headerHeight - iconSize) / 2, iconSize, iconSize);
            heading.SetBounds(pad + titleOffset, y, titleWidth, headerHeight);
            y += headerHeight;
            if (detail.Text.Length > 0) {
                y += Px(12);
                int d = TextRenderer.MeasureText(detail.Text, detail.Font, new Size(inner, int.MaxValue), flags).Height;
                detail.SetBounds(pad, y, inner, d); y += d;
            } else detail.SetBounds(pad, y, inner, 0);
            actions.MaximumSize = new Size(inner, 0);
            var preferred = actions.GetPreferredSize(new Size(inner, 0));
            if (preferred.Height > 0) {
                y += Px(18);
                actions.Location = new Point(embedded ? pad : width - pad - preferred.Width, y);
                y += preferred.Height;
            }
            int height = y + pad;
            int top = Math.Max(edge, (ClientSize.Height - height) / 2);
            card.SetBounds((ClientSize.Width - width) / 2 + AutoScrollPosition.X, top + AutoScrollPosition.Y, width, height);
            AutoScrollMinSize = new Size(0, height + edge * 2);
        } finally { arranging = false; }
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && headingFont != null) headingFont.Dispose();
    }
}
