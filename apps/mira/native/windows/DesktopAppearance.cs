using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// Native controls use the same surface palette and outline icon geometry as the dashboard.
internal enum DesktopGlyph { Open, Settings, Download, Connect, Stop, Exit, Offline, Info }

internal static class DesktopAppearance
{
    internal static GraphicsPath Round(Rectangle bounds, int radius)
    {
        int d = Math.Min(Math.Max(1, radius * 2), Math.Min(bounds.Width, bounds.Height));
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    internal static void Glyph(Graphics g, DesktopGlyph icon, Rectangle bounds, Color color)
    {
        var state = g.Save();
        try {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TranslateTransform(bounds.X, bounds.Y); g.ScaleTransform(bounds.Width / 24f, bounds.Height / 24f);
            using (var p = new Pen(color, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round }) {
                switch (icon) {
                    case DesktopGlyph.Open:
                        g.DrawRectangle(p, 3, 4, 18, 13); g.DrawLine(p, 12, 17, 12, 20); g.DrawLine(p, 8, 20, 16, 20); break;
                    case DesktopGlyph.Settings:
                        g.DrawLine(p, 4, 7, 7, 7); g.DrawEllipse(p, 7, 4, 6, 6); g.DrawLine(p, 13, 7, 20, 7);
                        g.DrawLine(p, 4, 17, 12, 17); g.DrawEllipse(p, 12, 14, 6, 6); g.DrawLine(p, 18, 17, 20, 17); break;
                    case DesktopGlyph.Download:
                        g.DrawLine(p, 12, 3, 12, 15); g.DrawLines(p, new[] { new Point(7,10), new Point(12,15), new Point(17,10) });
                        g.DrawLines(p, new[] { new Point(4,16), new Point(4,20), new Point(20,20), new Point(20,16) }); break;
                    case DesktopGlyph.Connect:
                        g.DrawLine(p, 8, 3, 8, 8); g.DrawLine(p, 16, 3, 16, 8); g.DrawLine(p, 5, 8, 19, 8);
                        g.DrawArc(p, 6, 6, 12, 11, 0, 180); g.DrawLine(p, 6, 8, 6, 12); g.DrawLine(p, 18, 8, 18, 12); g.DrawLine(p, 12, 17, 12, 21); break;
                    case DesktopGlyph.Stop:
                        g.DrawRectangle(p, 5, 5, 14, 14); break;
                    case DesktopGlyph.Exit:
                        g.DrawArc(p, 4, 4, 16, 16, -53, 286); g.DrawLine(p, 12, 2, 12, 12); break;
                    case DesktopGlyph.Offline:
                        g.DrawLine(p, 3, 3, 21, 21); g.DrawArc(p, -2, 4, 28, 28, 244, 67);
                        g.DrawArc(p, 0, 4, 24, 24, 220, 15); g.DrawArc(p, 4, 9, 16, 16, 221, 36);
                        g.DrawArc(p, 7, 14, 10, 10, 225, 75); g.DrawLine(p, 12, 20, 12, 20.5f); break;
                    case DesktopGlyph.Info:
                        g.DrawEllipse(p, 3, 3, 18, 18); g.DrawLine(p, 12, 11, 12, 16); g.DrawLine(p, 12, 7, 12, 7.3f); break;
                }
            }
        } finally { g.Restore(state); }
    }
}

internal sealed class DesktopMenuRenderer : ToolStripProfessionalRenderer
{
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(MiraWindow.Surface); }
    // Let WinForms measure the glyph column; the same surface continues beneath it.
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using (var p = new Pen(MiraWindow.Border)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
    }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (!e.Item.Selected || !e.Item.Enabled) return;
        int rowInset = Math.Max(1, (int)Math.Round(2 * e.Graphics.DpiY / 96));
        int sideInset = e.ToolStrip.DisplayRectangle.Top + rowInset;
        var rect = new Rectangle(0, 0, e.Item.Width, e.Item.Height - 1);
        rect.Inflate(-sideInset, -rowInset);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var fill = new SolidBrush(MiraWindow.Raised))
        using (var outline = DesktopAppearance.Round(rect, 5)) e.Graphics.FillPath(fill, outline);
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        int left = e.TextRectangle.Left;
        int size = Math.Min(e.ToolStrip.ImageScalingSize.Width, left * 2 / 3);
        if (e.Item.Tag is DesktopGlyph)
            DesktopAppearance.Glyph(e.Graphics, (DesktopGlyph)e.Item.Tag, new Rectangle((left - size) / 2, (e.Item.Height - size) / 2, size, size),
                e.Item.Enabled && e.Item.Selected ? MiraWindow.Accent : MiraWindow.Muted);
        e.TextRectangle = new Rectangle(left, 0, e.TextRectangle.Width, e.Item.Height);
        e.TextFormat = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine;
        e.TextColor = e.Item.Enabled ? MiraWindow.TextColor : MiraWindow.Muted;
        base.OnRenderItemText(e);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        using (var p = new Pen(MiraWindow.Border)) e.Graphics.DrawLine(p, 8, e.Item.Height / 2, e.Item.Width - 8, e.Item.Height / 2);
    }
}
