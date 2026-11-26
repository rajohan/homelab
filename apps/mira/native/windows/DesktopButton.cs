using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// Native counterparts to the primary, secondary and icon actions in packages/ui's buttonStyles.
internal sealed class DesktopButton : Button
{
    private static readonly Color PrimaryFill = ColorTranslator.FromHtml("#34567f");
    private static readonly Color PrimaryHover = ColorTranslator.FromHtml("#293f59");
    private static readonly Color PrimaryPressed = ColorTranslator.FromHtml("#1c3048");
    private static readonly Color SecondaryHover = ColorTranslator.FromHtml("#4a505a");
    private static readonly Color GhostText = ColorTranslator.FromHtml("#a7adb8");
    internal bool Primary { get; set; }
    internal DesktopGlyph? IconGlyph { get; set; }
    private bool hovered, pressed, spaceDown;
    internal DesktopButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        Cursor = Cursors.Hand;
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }
    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hovered = true; Invalidate(); }
    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovered = pressed = false; Invalidate(); }
    protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); pressed = e.Button == MouseButtons.Left; Invalidate(); }
    protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); pressed = false; Invalidate(); }
    protected override void OnKeyDown(KeyEventArgs e) { base.OnKeyDown(e); if (e.KeyCode == Keys.Space) { spaceDown = true; Invalidate(); } }
    protected override void OnKeyUp(KeyEventArgs e) { base.OnKeyUp(e); if (e.KeyCode == Keys.Space) { spaceDown = false; Invalidate(); } }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); spaceDown = false; Invalidate(); }
    private static Color HalfOpacity(Color ink, Color surface)
    {
        return Color.FromArgb((ink.R + surface.R + 1) / 2, (ink.G + surface.G + 1) / 2, (ink.B + surface.B + 1) / 2);
    }
    protected override void OnPaint(PaintEventArgs args)
    {
        if (Width < 4 || Height < 4) return;
        var g = args.Graphics;
        Color surround = Parent == null ? MiraWindow.Surface : Parent.BackColor;
        bool active = Enabled && (pressed || spaceDown);
        bool hover = Enabled && hovered;
        Color background, foreground;
        if (IconGlyph.HasValue) {
            background = active ? SecondaryHover : hover ? MiraWindow.Border : surround;
            foreground = hover ? MiraWindow.TextColor : GhostText;
        } else if (Primary) {
            background = active ? PrimaryPressed : hover ? PrimaryHover : PrimaryFill;
            foreground = Color.White;
        } else {
            background = active ? MiraWindow.Raised : hover ? SecondaryHover : MiraWindow.Border;
            foreground = MiraWindow.TextColor;
        }
        if (!Enabled) { background = HalfOpacity(background, surround); foreground = HalfOpacity(foreground, surround); }
        bool focus = Enabled && Focused && ShowFocusCues;
        Color ringColor = MiraWindow.Accent, ringOffset = MiraWindow.Surface;
        if (SystemInformation.HighContrast) {
            background = hover || Primary ? SystemColors.Highlight : SystemColors.Control;
            foreground = !Enabled ? SystemColors.GrayText : hover || Primary ? SystemColors.HighlightText : SystemColors.ControlText;
            ringColor = SystemColors.Highlight; ringOffset = SystemColors.Window;
        }
        g.Clear(surround); g.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(1, 1, Width - 3, Height - 3);
        int radius = Math.Max(3, DeviceDpi / 16);
        int ring = Math.Max(1, (int)Math.Round(DeviceDpi * 2 / 96.0));
        // WinForms clips at the control boundary. Reserve the web button's two rings inside it when tabbing.
        if (focus && Math.Min(bounds.Width, bounds.Height) > 4 * ring) {
            using (var shape = DesktopAppearance.Round(bounds, radius))
            using (var brush = new SolidBrush(ringColor)) g.FillPath(brush, shape);
            bounds.Inflate(-ring, -ring);
            using (var shape = DesktopAppearance.Round(bounds, Math.Max(1, radius - ring)))
            using (var brush = new SolidBrush(ringOffset)) g.FillPath(brush, shape);
            bounds.Inflate(-ring, -ring);
        }
        using (var shape = DesktopAppearance.Round(bounds, focus ? Math.Max(1, radius - 2 * ring) : radius))
        using (var fill = new SolidBrush(background)) g.FillPath(fill, shape);
        if (IconGlyph.HasValue) {
            int size = Math.Min(Height - 4, (int)Math.Round(DeviceDpi * 18 / 96.0));
            DesktopAppearance.Glyph(g, IconGlyph.Value, new Rectangle((Width - size) / 2, (Height - size) / 2, size, size), foreground);
        } else TextRenderer.DrawText(g, Text, Font, ClientRectangle, foreground,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
    }
}
