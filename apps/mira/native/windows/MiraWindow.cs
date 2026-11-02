using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// One native frame for the dashboard shell, local consent and Mira-owned notices.
// Keep the standard window styles so Windows still owns movement, resizing,
// keyboard system commands, taskbar behavior and Snap layouts.
internal class MiraWindow : Form
{
    internal static readonly Color Canvas = Color.FromArgb(11, 11, 12);
    internal static readonly Color Surface = Color.FromArgb(18, 19, 22);
    internal static readonly Color Raised = Color.FromArgb(26, 28, 32);
    internal static readonly Color Border = Color.FromArgb(42, 45, 51);
    internal static readonly Color TextColor = Color.FromArgb(239, 241, 245);
    internal static readonly Color Muted = Color.FromArgb(160, 166, 179);
    internal static readonly Color Accent = Color.FromArgb(91, 140, 255);
    protected readonly Panel Content = new Panel();
    private readonly CaptionPanel caption;
    private readonly CaptionButton minimize;
    private readonly CaptionButton maximize;
    private readonly CaptionButton close;
    private int pressed;
    private FormWindowState previousWindowState;
    private bool updatingWindowBounds;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Margins { internal int Left, Right, Top, Bottom; }
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr SetCapture(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr window, ref Margins margins);

    internal MiraWindow()
    {
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.None;
        Font = new Font("Segoe UI", 10);
        BackColor = Canvas; ForeColor = TextColor;
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        caption = new CaptionPanel(this) { Dock = DockStyle.Top, Height = 40, BackColor = Canvas };
        minimize = new CaptionButton(this, 8, "Minimize");
        maximize = new CaptionButton(this, 9, "Maximize");
        close = new CaptionButton(this, 20, "Close");
        caption.Controls.Add(minimize); caption.Controls.Add(maximize); caption.Controls.Add(close);
        Content.Dock = DockStyle.Fill;
        Controls.Add(Content); Controls.Add(caption);
        TextChanged += delegate { caption.Invalidate(); };
        caption.SizeChanged += delegate { LayoutCaption(); };
        Resize += delegate { LayoutCaption(); };
        LayoutCaption();
    }

    protected override CreateParams CreateParams
    {
        get {
            var parameters = base.CreateParams;
            parameters.Style &= unchecked((int)~0x80c00000); // No popup or OS-painted caption.
            parameters.Style |= 0x000c0000; // WS_THICKFRAME | WS_SYSMENU
            if (MinimizeBox) parameters.Style |= 0x00020000;
            if (MaximizeBox) parameters.Style |= 0x00010000;
            return parameters;
        }
    }

    private int ScalePixels(int pixels) { return Math.Max(1, (int)Math.Round(pixels * DeviceDpi / 96.0)); }

    private void LayoutCaption()
    {
        if (caption == null) return;
        int edge = WindowState == FormWindowState.Maximized ? 0 : ScalePixels(6);
        Padding = new Padding(edge);
        caption.Height = ScalePixels(40);
        int width = ScalePixels(44), right = caption.ClientSize.Width;
        close.SetBounds(right - width, 0, width, caption.Height);
        right -= width;
        maximize.Visible = MaximizeBox;
        if (MaximizeBox) { maximize.SetBounds(right - width, 0, width, caption.Height); right -= width; }
        minimize.Visible = MinimizeBox;
        if (MinimizeBox) minimize.SetBounds(right - width, 0, width, caption.Height);
        maximize.AccessibleName = WindowState == FormWindowState.Maximized ? "Restore" : "Maximize";
        caption.Invalidate(); maximize.Invalidate();
    }

    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        // Recalculate the non-client region immediately, including on handle
        // recreation when caption capabilities change.
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x37);
        var margins = new Margins { Left = 1, Right = 1, Top = 1, Bottom = 1 };
        DwmExtendFrameIntoClientArea(Handle, ref margins);
        LayoutCaption();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs args)
    {
        base.OnDpiChanged(args);
        LayoutCaption();
    }

    // Coordinates are signed: monitors can sit left of or above the primary screen.
    private Point ScreenPoint(IntPtr value)
    {
        long packed = value.ToInt64();
        return PointToClient(new Point((short)(packed & 0xffff), (short)((packed >> 16) & 0xffff)));
    }

    internal int HitTest(Point point)
    {
        if (WindowState != FormWindowState.Maximized) {
            int edge = ScalePixels(6);
            bool left = point.X < edge, right = point.X >= ClientSize.Width - edge;
            bool top = point.Y < edge, bottom = point.Y >= ClientSize.Height - edge;
            if (top) return left ? 13 : right ? 14 : 12;
            if (bottom) return left ? 16 : right ? 17 : 15;
            if (left) return 10;
            if (right) return 11;
        }
        if (caption != null && caption.Bounds.Contains(point)) {
            var local = new Point(point.X - caption.Left, point.Y - caption.Top);
            if (close.Bounds.Contains(local)) return 20;
            if (MaximizeBox && maximize.Bounds.Contains(local)) return 9;
            if (MinimizeBox && minimize.Bounds.Contains(local)) return 8;
            return 2;
        }
        return 1;
    }

    internal void CaptionAction(int hit)
    {
        int command = hit == 20 ? 0xf060 : hit == 8 && MinimizeBox ? 0xf020 :
            hit == 9 && MaximizeBox ? (WindowState == FormWindowState.Maximized ? 0xf120 : 0xf030) : 0;
        if (command != 0) SendMessage(Handle, 0x112, new IntPtr(command), IntPtr.Zero);
    }

    private void Hover(int hit)
    {
        minimize.Hovered = hit == 8; maximize.Hovered = hit == 9; close.Hovered = hit == 20;
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x47 && !updatingWindowBounds) { // WM_WINDOWPOSCHANGED
            // .NET Framework restores the saved client size plus a native frame,
            // although our frame is already inside that client area. Keep the
            // saved outer size while Windows retains its restored position.
            var restoredSize = RestoreBounds.Size;
            updatingWindowBounds = true;
            try {
                base.WndProc(ref message);
                if (previousWindowState != FormWindowState.Normal && WindowState == FormWindowState.Normal &&
                    restoredSize.Width > 0 && restoredSize.Height > 0) Size = restoredSize;
                previousWindowState = WindowState;
            } finally { updatingWindowBounds = false; }
            return;
        }
        // The custom client frame paints its own title and buttons, including
        // when activation would otherwise redraw the classic non-client caption.
        if (message.Msg == 0x85 || message.Msg == 0x86) {
            message.Result = message.Msg == 0x86 ? new IntPtr(1) : IntPtr.Zero; return;
        }
        if (message.Msg == 0x83) { // WM_NCCALCSIZE, including the initial RECT-only form
            if (WindowState == FormWindowState.Maximized) {
                var rect = (Rect)Marshal.PtrToStructure(message.LParam, typeof(Rect));
                var work = Screen.FromHandle(Handle).WorkingArea;
                rect.Left = Math.Max(rect.Left, work.Left); rect.Top = Math.Max(rect.Top, work.Top);
                rect.Right = Math.Min(rect.Right, work.Right); rect.Bottom = Math.Min(rect.Bottom, work.Bottom);
                Marshal.StructureToPtr(rect, message.LParam, false);
            }
            message.Result = IntPtr.Zero; return;
        }
        if (message.Msg == 0x84) { // WM_NCHITTEST, including HTMAXBUTTON for Windows Snap
            message.Result = new IntPtr(HitTest(ScreenPoint(message.LParam))); return;
        }
        if (message.Msg == 0xa0 && caption != null) Hover(HitTest(ScreenPoint(message.LParam)));
        if (message.Msg == 0x2a2 && caption != null) Hover(0); // WM_NCMOUSELEAVE
        if (message.Msg == 0xa1 && caption != null) {
            int hit = message.WParam.ToInt32();
            if (hit == 8 || hit == 9 || hit == 20) {
                pressed = hit; SetCapture(Handle); message.Result = IntPtr.Zero; return;
            }
        }
        if (message.Msg == 0x202 && pressed != 0) { // Captured caption-button release
            int hit = HitTest(PointToClient(Cursor.Position)), action = pressed;
            pressed = 0; ReleaseCapture(); Hover(0);
            if (hit == action) CaptionAction(action);
            message.Result = IntPtr.Zero; return;
        }
        if (message.Msg == 0x215) { pressed = 0; if (caption != null) Hover(0); }
        base.WndProc(ref message);
    }

    private sealed class CaptionPanel : Panel
    {
        private readonly MiraWindow window;
        internal CaptionPanel(MiraWindow owner) { window = owner; DoubleBuffered = true; }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
            base.WndProc(ref message);
        }
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            int iconSize = window.ScalePixels(22), left = window.ScalePixels(8);
            if (window.Icon != null) args.Graphics.DrawIcon(window.Icon, new Rectangle(left, (Height - iconSize) / 2, iconSize, iconSize));
            int textLeft = left + iconSize + window.ScalePixels(10);
            int right = window.MinimizeBox ? window.minimize.Left : window.MaximizeBox ? window.maximize.Left : window.close.Left;
            TextRenderer.DrawText(args.Graphics, window.Text, Font, new Rectangle(textLeft, 0, Math.Max(0, right - textLeft), Height),
                TextColor, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
            using (var pen = new Pen(Border)) args.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
        }
    }

    private sealed class CaptionButton : Button
    {
        private readonly MiraWindow window;
        private readonly int hit;
        private bool hovered;
        internal CaptionButton(MiraWindow owner, int code, string name)
        {
            window = owner; hit = code; AccessibleName = name; TabStop = false;
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; BackColor = Canvas;
            Click += delegate { window.CaptionAction(hit); };
        }
        internal bool Hovered { set { if (hovered != value) { hovered = value; Invalidate(); } } }
        protected override void WndProc(ref Message message)
        {
            // Let the top-level HWND return the caption hit-test code; keep this
            // real button for keyboard and accessibility Invoke support.
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
            base.WndProc(ref message);
        }
        protected override void OnPaint(PaintEventArgs args)
        {
            bool keyboardFocus = Focused && ShowFocusCues;
            args.Graphics.Clear(hovered || keyboardFocus ? (hit == 20 ? Color.FromArgb(185, 40, 53) : Raised) : Canvas);
            int size = window.ScalePixels(10), x = (Width - size) / 2, y = (Height - size) / 2;
            using (var pen = new Pen(TextColor, Math.Max(1, window.ScalePixels(1)))) {
                if (hit == 8) args.Graphics.DrawLine(pen, x, y + size / 2, x + size, y + size / 2);
                else if (hit == 20) { args.Graphics.DrawLine(pen, x, y, x + size, y + size); args.Graphics.DrawLine(pen, x + size, y, x, y + size); }
                else if (window.WindowState == FormWindowState.Maximized) {
                    int offset = window.ScalePixels(3);
                    args.Graphics.DrawRectangle(pen, x + offset, y, size - offset, size - offset);
                    using (var fill = new SolidBrush(hovered || keyboardFocus ? Raised : Canvas)) args.Graphics.FillRectangle(fill, x, y + offset, size - offset, size - offset);
                    args.Graphics.DrawRectangle(pen, x, y + offset, size - offset, size - offset);
                } else args.Graphics.DrawRectangle(pen, x, y, size, size);
            }
            if (keyboardFocus) ControlPaint.DrawFocusRectangle(args.Graphics, new Rectangle(4, 4, Width - 8, Height - 8), TextColor, Canvas);
            using (var border = new Pen(Border)) args.Graphics.DrawLine(border, 0, Height - 1, Width, Height - 1);
        }
    }
}
