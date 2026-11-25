using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Homelab.Mira.Computer
{
    // Private, piped worker for the immutable all-displays grant. Window and
    // primary-only sessions use their original restricted drivers.
    internal sealed class DisplayWorker
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Mouse
        {
            internal int X, Y;
            internal uint Data, Flags, Time;
            internal UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Key
        {
            internal ushort KeyCode, Scan;
            internal uint Flags, Time;
            internal UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputData
        {
            [FieldOffset(0)]
            internal Mouse Mouse;
            [FieldOffset(0)]
            internal Key Key;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Input
        {
            internal uint Type;
            internal InputData Data;
        }
        [DllImport("user32.dll")]
        private static extern uint SendInput(uint count, Input[] events, int size);
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr window, uint kind);
        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr context);
        [DllImport("gdi32.dll")]
        private static extern int SetStretchBltMode(IntPtr context, int mode);
        [DllImport("gdi32.dll")]
        private static extern bool SetBrushOrgEx(IntPtr context, int x, int y, IntPtr prior);
        [DllImport("gdi32.dll")]
        private static extern bool StretchBlt(IntPtr destination, int x, int y, int w, int h, IntPtr source,
                                              int sx, int sy, int sw, int sh, uint operation);

        private readonly DisplayLayout layout = DisplayLayout.Current();
        private readonly NativeWindows.DesktopState session = NativeWindows.ReadyDesktop();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly bool control;
        private Size frame;
        private long observedAt = -1;
        private NativeWindows.WindowIdentity foreground;

        private DisplayWorker(Dictionary<string, object> grant)
        {
            ConsentProtocol.Keys(grant, "scope", "layout", "mode", "delivery");
            string mode = ConsentProtocol.Text(grant, "mode", 7);
            if ((mode != "view" && mode != "control") ||
                ConsentProtocol.Text(grant, "scope", 8) != "displays" ||
                ConsentProtocol.Text(grant, "delivery", 12) != "foreground" ||
                ConsentProtocol.Text(grant, "layout", 64) != layout.Identity)
                throw new InvalidDataException("Invalid display grant.");
            control = mode == "control";
        }

        internal static int Run()
        {
            var json = new JavaScriptSerializer { MaxJsonLength = 3 * 1024 * 1024, RecursionLimit = 8 };
            using (var lifetime = new Timer(
                       delegate { Environment.Exit(1); }, null, 300000,
                       Timeout.Infinite)) using (var reader =
                                                     new StreamReader(
                                                         Console.OpenStandardInput(),
                                                         new UTF8Encoding(false, true), false,
                                                         4096)) using (var writer =
                                                                           new StreamWriter(
                                                                               Console.OpenStandardOutput(),
                                                                               new UTF8Encoding(false),
                                                                               4096) { AutoFlush = true })
            {
                int previous = 0;
                DisplayWorker worker = null;
                for (;;)
                {
                    string line = ConsentProtocol.ReadLine(reader, 32768);
                    if (line == null)
                        return 0;
                    var message = json.DeserializeObject(line) as Dictionary<string, object>;
                    ConsentProtocol.Keys(message, "id", "method", "params");
                    int id = ConsentProtocol.Id(message, previous);
                    previous = id;
                    string method = ConsentProtocol.Text(message, "method", 16);
                    var parameters = ConsentProtocol.Parameters(message);
                    object result;
                    if (worker == null)
                    {
                        if (method != "initialize")
                            throw new InvalidDataException("Initialize first.");
                        worker = new DisplayWorker(parameters);
                        result = new { version = 1, driver = "windows-displays-v1" };
                    }
                    else
                    {
                        worker.Check();
                        result = worker.Execute(method, parameters);
                        worker.Check();
                    }
                    writer.WriteLine(json.Serialize(new { id = id, result = result }));
                }
            }
        }

        private void Check()
        {
            var current = NativeWindows.ReadyDesktop();
            if (current.SessionId != session.SessionId || current.ConnectedAt != session.ConnectedAt ||
                DisplayLayout.Current().Identity != layout.Identity)
                throw new InvalidOperationException("Display access changed.");
        }

        private static NativeWindows.WindowIdentity InputWindow(IntPtr window)
        {
            try
            {
                var identity = NativeWindows.Identity(GetAncestor(window, 2));
                // The local permission and Stop surface belongs to the operator.
                return String.Equals(Path.GetFileName(identity.Executable), "mira-computer-consent.exe",
                                     StringComparison.OrdinalIgnoreCase)
                           ? null
                           : identity;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }

        private object Execute(string method, Dictionary<string, object> args)
        {
            if (method == "observe")
            {
                ConsentProtocol.Keys(args);
                var before = control ? InputWindow(GetForegroundWindow()) : null;
                byte[] jpg = Capture(3200);
                if (jpg.Length > 1500000)
                    jpg = Capture(1600);
                if (jpg.Length > 1500000)
                    jpg = Capture(1024);
                if (jpg.Length > 1500000)
                    throw new InvalidDataException("Display frame is too large.");
                var after = control ? InputWindow(GetForegroundWindow()) : null;
                foreground =
                    before != null && after != null && NativeWindows.SameWindow(before, after) ? after : null;
                observedAt = clock.ElapsedMilliseconds;
                return new { snapshot = Guid.NewGuid().ToString(), width = frame.Width, height = frame.Height,
                             coordinateInput = control,
                             content =
                                 new { content = new[] { new { type = "image", mediaType = "image/jpeg",
                                                               data = Convert.ToBase64String(jpg) } } } };
            }
            long age = clock.ElapsedMilliseconds - observedAt;
            bool ready = control && observedAt >= 0 && age <= 60000;
            observedAt = -1;
            if (!ready)
                return new { effect = "refused" };
            // Held shortcuts or mouse buttons could change the meaning of literal input.
            foreach (int key in new[] { 1, 2, 4, 16, 17, 18, 91, 92 })
                if (GetAsyncKeyState(key) < 0)
                    return new { effect = "refused" };
            Input[] events;
            if (method == "click")
            {
                ConsentProtocol.Keys(args, "x", "y");
                Point target;
                if (!(args["x"] is int) || !(args["y"] is int) ||
                    !layout.Map(new Point((int)args["x"], (int)args["y"]), frame, out target) ||
                    InputWindow(WindowFromPoint(target)) == null)
                    return new { effect = "refused" };
                var pos = layout.Absolute(target);
                events = new[] { new Input { Data = new InputData { Mouse = new Mouse { X = pos.X, Y = pos.Y,
                                                                                        Flags = 0xC001 } } },
                                 new Input { Data = new InputData { Mouse = new Mouse { Flags = 2 } } },
                                 new Input { Data = new InputData { Mouse = new Mouse { Flags = 4 } } } };
            }
            else if (method == "type")
            {
                ConsentProtocol.Keys(args, "text");
                string text = args["text"] as string;
                var current = InputWindow(GetForegroundWindow());
                if (String.IsNullOrEmpty(text) || text.Length > 4096 || foreground == null ||
                    current == null || !NativeWindows.SameWindow(foreground, current))
                    return new { effect = "refused" };
                events = new Input[text.Length * 2];
                for (int i = 0; i < text.Length; i++)
                {
                    events[2 * i] =
                        new Input { Type = 1,
                                    Data = new InputData { Key = new Key { Scan = text[i], Flags = 4 } } };
                    events[2 * i + 1] =
                        new Input { Type = 1,
                                    Data = new InputData { Key = new Key { Scan = text[i], Flags = 6 } } };
                }
            }
            else
                return new { effect = "refused" };
            Check();
            uint delivered = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
            return new { effect = delivered == 0              ? "refused"
                                  : delivered < events.Length ? "partial"
                                                              : "unverified" };
        }

        private byte[] Capture(int limit)
        {
            frame = layout.FrameSize(limit);
            IntPtr source = GetDC(IntPtr.Zero);
            if (source == IntPtr.Zero)
                throw new InvalidOperationException("Display capture unavailable.");
            try
            {
                return Render(layout, frame, source);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, source);
            }
        }

        internal static byte[] Render(DisplayLayout layout, Size frame, IntPtr source)
        {
            using (var image = new Bitmap(frame.Width, frame.Height, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(image))
                {
                    graphics.Clear(Color.Black);
                    IntPtr destination = graphics.GetHdc();
                    try
                    {
                        if (SetStretchBltMode(destination, 4) == 0 ||
                            !SetBrushOrgEx(destination, 0, 0, IntPtr.Zero))
                            throw new InvalidOperationException("Cannot scale display.");
                        foreach (var r in layout.Monitors)
                        {
                            var d = layout.Project(r, frame);
                            if (d.Width <= 0 || d.Height <= 0 ||
                                !StretchBlt(destination, d.X, d.Y, d.Width, d.Height, source, r.X, r.Y,
                                            r.Width, r.Height, 0x40CC0020))
                                throw new InvalidOperationException("Display capture unavailable.");
                        }
                    }
                    finally
                    {
                        graphics.ReleaseHdc(destination);
                    }
                }
                using (var bytes = new MemoryStream())
                {
                    image.Save(bytes, ImageFormat.Jpeg);
                    return bytes.ToArray();
                }
            }
        }
    }
}
