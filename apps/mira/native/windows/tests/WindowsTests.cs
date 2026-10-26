using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Homelab.Mira.Computer;

internal static class WindowsTests
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetDesktopWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    private static int assertions;
    private static void Check(bool value)
    {
        assertions++;
        if (!value) throw new Exception("Windows consent assertion failed.");
    }
    private static void Reject(Action operation)
    {
        Reject<InvalidDataException>(operation);
    }
    private static void Reject<T>(Action operation) where T : Exception
    {
        bool failed = false;
        try { operation(); } catch (T) { failed = true; }
        Check(failed);
    }
    private static Dictionary<string, object> Request()
    {
        return new Dictionary<string, object>
        {
            { "id", Guid.NewGuid().ToString("D") }, { "runId", Guid.NewGuid().ToString("D") },
            { "origin", "https://computer.example.test" }, { "mode", "view" },
            { "consentExpiresAt", DateTime.UtcNow.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) },
            { "expiresAt", DateTime.UtcNow.AddMinutes(2).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) }
        };
    }
    private static int Main()
    {
        try
        {
            var json = new JavaScriptSerializer();
            Check(ConsentRequest.Parse(json.Serialize(Request())).Mode == "view");
            foreach (var change in new[]
            {
                new KeyValuePair<string, object>("origin", "http://computer.example.test"),
                new KeyValuePair<string, object>("origin", "https://user:password@computer.example.test"),
                new KeyValuePair<string, object>("origin", "https://computer.example.test/path"),
                new KeyValuePair<string, object>("origin", "https://computer.example.test/?token=private"),
                new KeyValuePair<string, object>("mode", "shell"),
                new KeyValuePair<string, object>("id", "not-an-id"),
                new KeyValuePair<string, object>("runId", "not-a-run"),
                new KeyValuePair<string, object>("consentExpiresAt", "2000-01-01T00:00:00.000Z"),
                new KeyValuePair<string, object>("expiresAt", DateTime.UtcNow.AddHours(1).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)),
                new KeyValuePair<string, object>("executable", "injected.exe")
            })
            {
                var request = Request();
                request[change.Key] = change.Value;
                Reject(delegate { ConsentRequest.Parse(json.Serialize(request)); });
            }
            var missing = Request();
            missing.Remove("mode");
            Reject(delegate { ConsentRequest.Parse(json.Serialize(missing)); });
            Reject(delegate { ConsentProtocol.Object(new string('x', 8193)); });
            Reject(delegate { ConsentProtocol.Object("[]"); });
            Reject(delegate { ConsentProtocol.ReadLine(new StringReader(new string('\r', 8194))); });
            Check(ConsentProtocol.ReadLine(new StringReader("{}\r\n")) == "{}");
            Check(ConsentProtocol.ReadLine(new StringReader("{partial")) == null);
            Check(ConsentProtocol.ReadLine(new StringReader("{\"a\":\"x\ry\"}\n")).Contains("\r"));
            var message = ConsentProtocol.Object("{\"id\":2,\"method\":\"check\",\"params\":{}}");
            Check(ConsentProtocol.Id(message, 1) == 2);
            Reject(delegate { ConsentProtocol.Id(message, 2); });
            message["id"] = "2";
            Reject(delegate { ConsentProtocol.Id(message, 1); });
            message["params"] = new object[] { };
            Reject(delegate { ConsentProtocol.Parameters(message); });
            Reject<InvalidOperationException>(delegate { NativeWindows.Identity(GetDesktopWindow()); });
            IntPtr shell = GetShellWindow();
            if (shell != IntPtr.Zero) Reject<InvalidOperationException>(delegate { NativeWindows.Identity(shell); });
            Check(NativeWindows.SessionReady(1, 1, 1, 0, 1));
            foreach (int state in new[] { 1, 2, 3, 4, 5, 6, 7, 8, 9 })
                Check(!NativeWindows.SessionReady(1, 1, 1, state, 1));
            foreach (int flags in new[] { -1, 0, 2 })
                Check(!NativeWindows.SessionReady(1, 1, 1, 0, flags));
            Check(!NativeWindows.SessionReady(0, 1, 0, 0, 1));
            Check(!NativeWindows.SessionReady(1, 2, 1, 0, 1));
            Check(!NativeWindows.SessionReady(1, 1, 2, 0, 1));
            var left = new NativeWindows.WindowIdentity { Handle = new IntPtr(123), ProcessId = 456, StartedAt = 789, Executable = @"C:\fixture.exe" };
            var right = new NativeWindows.WindowIdentity { Handle = new IntPtr(123), ProcessId = 456, StartedAt = 789, Executable = @"c:\fixture.exe", Title = "Changed text" };
            Check(NativeWindows.SameWindow(left, right));
            right.StartedAt++;
            Check(!NativeWindows.SameWindow(left, right));
            right.StartedAt--;
            right.Handle = new IntPtr(124);
            Check(!NativeWindows.SameWindow(left, right));
            right.Handle = left.Handle;
            right.ProcessId++;
            Check(!NativeWindows.SameWindow(left, right));
            right.ProcessId--;
            right.Executable = @"C:\other.exe";
            Check(!NativeWindows.SameWindow(left, right));
            Console.WriteLine("{\"windowsConsent\":\"passed\",\"assertions\":" + assertions + "}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows consent tests failed after " + assertions + " assertions (" + error.GetType().Name + ").");
            return 1;
        }
    }
}
