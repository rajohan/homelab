using System.Drawing;
using System.Windows.Forms;

// Keep native keyboard/accessibility semantics while rendering readable disabled text on the dark surface.
internal sealed class DesktopButton : Button
{
    protected override void OnPaint(PaintEventArgs args)
    {
        if (Enabled) { base.OnPaint(args); return; }
        args.Graphics.Clear(BackColor);
        using (var border = new Pen(MiraWindow.Border))
            args.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
        TextRenderer.DrawText(args.Graphics, Text, Font, ClientRectangle, MiraWindow.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}
