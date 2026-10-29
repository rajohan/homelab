using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Homelab.Mira.Computer;

internal static class CaptureFixture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Bounds { internal int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Bounds bounds, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 1 || (args.Length == 1 && args[0] != "--resizable") || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" ||
            !Console.IsInputRedirected || !Console.IsOutputRedirected) return 2;
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles();
        using (var target = new Form { Text = "Mira window capture target", BackColor = Color.Cyan,
            ClientSize = new Size(400, 240), StartPosition = FormStartPosition.Manual,
            Location = new Point(100, 100), FormBorderStyle = args.Length == 1 ? FormBorderStyle.Sizable : FormBorderStyle.FixedSingle })
        using (var cover = new Form { Text = "Mira independent overlay", BackColor = Color.Magenta,
            StartPosition = FormStartPosition.Manual, FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false, TopMost = true })
        using (var dispatcher = new Control())
        using (var context = new ApplicationContext())
        using (var deadline = new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 60000, Timeout.Infinite))
        {
            if (dispatcher.Handle == IntPtr.Zero) return 1;
            target.Paint += delegate(object sender, PaintEventArgs paint)
            {
                paint.Graphics.FillRectangle(Brushes.Red, 12, 12, 3, 3);
                paint.Graphics.FillRectangle(Brushes.Lime, target.ClientSize.Width - 15, target.ClientSize.Height - 15, 3, 3);
                paint.Graphics.FillRectangle(Brushes.Blue, 12, target.ClientSize.Height - 15, 3, 3);
            };
            target.Shown += delegate
            {
                var input = new Thread(delegate()
                {
                    try
                    {
                        using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)))
                        {
                            int previous = 0;
                            for (;;)
                            {
                                string line = ConsentProtocol.ReadLine(reader);
                                if (line == null) break;
                                var request = ConsentProtocol.Object(line);
                                ConsentProtocol.Keys(request, "id", "method", "params");
                                int id = ConsentProtocol.Id(request, previous); previous = id;
                                string method = ConsentProtocol.Text(request, "method", 12);
                                var parameters = ConsentProtocol.Parameters(request);
                                object result = null;
                                dispatcher.Invoke((Action)delegate
                                {
                                    if (method == "state")
                                    {
                                        ConsentProtocol.Keys(parameters);
                                        long created, exited, kernel, user;
                                        using (var process = Process.GetCurrentProcess())
                                        {
                                            if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException();
                                            result = new { pid = process.Id, windowId = target.Handle.ToInt64().ToString(), started = created.ToString() };
                                        }
                                    }
                                    else if (method == "cover")
                                    {
                                        ConsentProtocol.Keys(parameters);
                                        cover.Bounds = target.Bounds;
                                        cover.Show(); cover.BringToFront(); cover.Refresh();
                                        if (DwmFlush() != 0 || WindowFromPoint(new Point(target.Left + target.Width / 2, target.Top + target.Height / 2)) != cover.Handle)
                                            throw new InvalidOperationException("The owned overlay did not cover the target.");
                                        result = new { covered = true };
                                    }
                                    else if (method == "minimize")
                                    {
                                        ConsentProtocol.Keys(parameters);
                                        cover.Hide(); target.WindowState = FormWindowState.Minimized;
                                        result = new { minimized = true };
                                    }
                                    else if (method == "close")
                                    {
                                        ConsentProtocol.Keys(parameters);
                                        IntPtr window = target.Handle;
                                        target.Close();
                                        if (IsWindow(window)) throw new InvalidOperationException("The owned target is still open.");
                                        result = new { closed = true };
                                    }
                                    else if (method == "alive")
                                    {
                                        ConsentProtocol.Keys(parameters);
                                        using (var process = Process.GetCurrentProcess())
                                            result = new { pid = process.Id };
                                    }
                                    else if (method == "image")
                                    {
                                        ConsentProtocol.Keys(parameters, "png");
                                        byte[] bytes = Convert.FromBase64String(ConsentProtocol.Text(parameters, "png", 6000));
                                        using (var stream = new MemoryStream(bytes))
                                        using (var image = new Bitmap(stream))
                                        {
                                            Bounds bounds;
                                            if (DwmGetWindowAttribute(target.Handle, 9, out bounds, Marshal.SizeOf(typeof(Bounds))) != 0 ||
                                                image.Width != bounds.Right - bounds.Left - 2 || image.Height != bounds.Bottom - bounds.Top - 2)
                                                throw new InvalidOperationException("Capture does not match independently measured frame bounds.");
                                            Point[] points = { new Point(13, 13), new Point(target.ClientSize.Width - 14, target.ClientSize.Height - 14), new Point(13, target.ClientSize.Height - 14) };
                                            Color[] colors = { Color.Red, Color.Lime, Color.Blue };
                                            for (int i = 0; i < points.Length; i++)
                                            {
                                                Point screen = target.PointToScreen(points[i]);
                                                Color pixel = image.GetPixel(screen.X - bounds.Left - 1, screen.Y - bounds.Top - 1);
                                                if (pixel.R != colors[i].R || pixel.G != colors[i].G || pixel.B != colors[i].B)
                                                    throw new InvalidOperationException("Capture crop shifted independently positioned fixture markers.");
                                            }
                                            foreach (int x in new[] { image.Width / 3, image.Width / 2, 2 * image.Width / 3 })
                                                foreach (int y in new[] { image.Height / 3, image.Height / 2, 2 * image.Height / 3 })
                                                {
                                                    Color color = image.GetPixel(x, y);
                                                    if (color.R > 5 || color.G < 250 || color.B < 250) throw new InvalidOperationException("Capture contains pixels from outside the target.");
                                                }
                                            result = new { targetPixels = true };
                                        }
                                    }
                                    else throw new InvalidOperationException();
                                });
                                ConsentProtocol.Write(new { id = id, result = result });
                            }
                        }
                    }
                    catch (Exception) { Environment.ExitCode = 1; }
                    finally { try { dispatcher.BeginInvoke((Action)context.ExitThread); } catch (InvalidOperationException) { } }
                });
                input.IsBackground = true;
                input.Start();
            };
            target.Show();
            Application.Run(context);
        }
        return Environment.ExitCode;
    }
}
