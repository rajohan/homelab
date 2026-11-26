using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Homelab.Mira.Computer
{
    // Both the consent UI and the worker use PerMonitorV2 physical pixels. The hash binds
    // the monitor names, primary flag and rectangles without sending them to the server.
    internal sealed class DisplayLayout
    {
        internal readonly Rectangle Bounds;
        internal readonly Rectangle[] Monitors;
        internal readonly string Identity;

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect
        {
            internal int Left, Top, Right, Bottom;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MonitorInfo
        {
            internal int Size;
            internal Rect Monitor, Work;
            internal int Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            internal string Name;
        }
        private delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref Rect bounds, IntPtr data);
        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback,
                                                       IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")]
        private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);

        internal DisplayLayout(Rectangle[] monitors, string names)
        {
            if (monitors.Length == 0 || monitors.Any(r => r.Width <= 0 || r.Height <= 0))
                throw new InvalidOperationException("Invalid display layout.");
            Monitors = monitors;
            Bounds = monitors.Aggregate(Rectangle.Union);
            if (Bounds.Width <= 0 || Bounds.Height <= 0 || Bounds.Width > 65536 || Bounds.Height > 65536)
                throw new InvalidOperationException("Unsupported display coordinates.");
            var key = new StringBuilder(names);
            foreach (var r in monitors)
                key.AppendFormat(CultureInfo.InvariantCulture, "|{0},{1},{2},{3}", r.X, r.Y, r.Width,
                                 r.Height);
            using (var digest = SHA256.Create()) Identity =
                BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(key.ToString())))
                    .Replace("-", "")
                    .ToLowerInvariant();
        }

        internal static DisplayLayout Current()
        {
            if (GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) != 2)
                throw new InvalidOperationException("Physical display coordinates are unavailable.");
            var displays = new SortedDictionary<string, Rectangle>(StringComparer.Ordinal);
            bool ok = EnumDisplayMonitors(
                IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Rect r, IntPtr data) {
                    var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
                    if (!GetMonitorInfo(monitor, ref info))
                        return false;
                    string key = info.Name + (info.Flags == 1 ? "*" : "");
                    if (displays.ContainsKey(key))
                        return false;
                    displays.Add(key, Rectangle.FromLTRB(info.Monitor.Left, info.Monitor.Top,
                                                         info.Monitor.Right, info.Monitor.Bottom));
                    return true;
                }, IntPtr.Zero);
            if (!ok)
                throw new InvalidOperationException("The display layout is unavailable.");
            return new DisplayLayout(displays.Values.ToArray(), string.Join("|", displays.Keys));
        }

        internal Size FrameSize(int limit)
        {
            double scale = Math.Min(1, (double)limit / Math.Max(Bounds.Width, Bounds.Height));
            return new Size(Math.Max(1, (int)Math.Round(Bounds.Width * scale)),
                            Math.Max(1, (int)Math.Round(Bounds.Height * scale)));
        }
        internal Rectangle Project(Rectangle r, Size frame)
        {
            return Rectangle.FromLTRB(
                (int)Math.Round((r.Left - Bounds.Left) * (double)frame.Width / Bounds.Width),
                (int)Math.Round((r.Top - Bounds.Top) * (double)frame.Height / Bounds.Height),
                (int)Math.Round((r.Right - Bounds.Left) * (double)frame.Width / Bounds.Width),
                (int)Math.Round((r.Bottom - Bounds.Top) * (double)frame.Height / Bounds.Height));
        }
        internal bool Map(Point pixel, Size frame, out Point physical)
        {
            foreach (var monitor in Monitors)
            {
                var area = Project(monitor, frame);
                if (!area.Contains(pixel))
                    continue;
                physical =
                    new Point(monitor.Left + (int)((pixel.X - area.Left + .5) * monitor.Width / area.Width),
                              monitor.Top + (int)((pixel.Y - area.Top + .5) * monitor.Height / area.Height));
                return true;
            }
            physical = Point.Empty;
            return false;
        }
        internal Point Absolute(Point p)
        {
            return new Point(AbsoluteAxis(p.X - Bounds.Left, Bounds.Width),
                             AbsoluteAxis(p.Y - Bounds.Top, Bounds.Height));
        }
        private static int AbsoluteAxis(int pixel, int extent)
        {
            // Select the centre of the integer inputs that Windows maps onto this pixel.
            long first = ((long)pixel * 65536 + extent - 1) / extent;
            long next = ((long)(pixel + 1) * 65536 + extent - 1) / extent;
            return (int)((first + next - 1) / 2);
        }
    }
}
