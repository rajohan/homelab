using System;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class MiraWindowTests
{
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

    internal static void Run(Action<bool> check)
    {
        // This form is never shown, has no WebView and grants no computer access.
        using (var form = new MiraWindow()) {
            form.Text = "Mira frame qualification";
            form.Size = new Size(800, 600); form.Location = new Point(-900, -700);
            IntPtr handle = form.Handle;
            var create = typeof(Control).GetMethod("CreateControl", BindingFlags.Instance | BindingFlags.NonPublic, null, new[] { typeof(bool) }, null);
            create.Invoke(form, new object[] { true });
            check(form.ClientSize == form.Size);
            form.PerformLayout();
            int width = form.ClientSize.Width, height = form.ClientSize.Height;
            check(form.HitTest(new Point(0, 0)) == 13);
            check(form.HitTest(new Point(width - 1, 0)) == 14);
            check(form.HitTest(new Point(0, height - 1)) == 16);
            check(form.HitTest(new Point(width - 1, height - 1)) == 17);
            check(form.HitTest(new Point(width / 2, 0)) == 12);
            check(form.HitTest(new Point(width / 2, height - 1)) == 15);
            check(form.HitTest(new Point(0, height / 2)) == 10);
            check(form.HitTest(new Point(width - 1, height / 2)) == 11);
            check(form.HitTest(new Point(width / 2, height / 2)) == 1);
            check(form.HitTest(new Point(80, 20)) == 2);
            foreach (var item in new[] { new { Name = "Minimize", Code = 8 }, new { Name = "Maximize", Code = 9 }, new { Name = "Close", Code = 20 } }) {
                var button = Find(form, item.Name);
                check(button != null && button is Button && !button.TabStop);
                check(button.Top == 0 && button.Parent.Top == 0);
                var center = button.PointToScreen(new Point(button.Width / 2, button.Height / 2));
                if (form.HitTest(form.PointToClient(center)) != item.Code)
                    throw new Exception(item.Name + " hit=" + form.HitTest(form.PointToClient(center)) + " point=" + form.PointToClient(center) + " caption=" + button.Parent.Bounds + " button=" + button.Bounds);
                check(form.HitTest(form.PointToClient(center)) == item.Code);
                long packed = ((long)(ushort)center.Y << 16) | (ushort)center.X;
                check(SendMessage(handle, 0x84, IntPtr.Zero, new IntPtr(packed)).ToInt32() == item.Code);
                check(SendMessage(button.Handle, 0x84, IntPtr.Zero, new IntPtr(packed)).ToInt32() == -1);
            }
            form.MaximizeBox = false; form.MinimizeBox = false;
            form.Size = new Size(500, 360); form.PerformLayout();
            var close = Find(form, "Close");
            check(close.Right <= close.Parent.ClientSize.Width);
            var maximize = Find(form, "Maximize");
            check(!maximize.Visible);
            check(form.HitTest(new Point(80, 20)) == 2);
        }
    }

    private static Control Find(Control control, string name)
    {
        foreach (Control child in control.Controls) {
            if (child.AccessibleName == name) return child;
            var found = Find(child, name);
            if (found != null) return found;
        }
        return null;
    }
}
