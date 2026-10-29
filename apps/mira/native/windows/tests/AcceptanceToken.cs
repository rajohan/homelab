using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Principal;

// Test-only launcher for GitHub's elevated Windows runner. It reduces only its
// child token. A separately scoped test helper restores the hosted desktop ACLs.
internal static class AcceptanceToken
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup
    {
        internal int Size;
        internal string Reserved, Desktop, Title;
        internal uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        internal short Show, ReservedSize;
        internal IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAttributes { internal IntPtr Sid; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Child { internal IntPtr Process, Thread; internal uint Id, ThreadId; }
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, uint length, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, ref SidAttributes disabled, uint privilegesCount, IntPtr privileges, uint restrictedCount, IntPtr restricted, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr token, string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out Child child);

    internal static bool IsUnelevated()
    {
        IntPtr token;
        Require(OpenProcessToken(GetCurrentProcess(), 8, out token));
        try
        {
            int elevated;
            uint returned;
            Require(GetTokenInformation(token, 20, out elevated, 4, out returned) && returned == 4);
            return elevated == 0;
        }
        finally { CloseHandle(token); }
    }
    internal static int Run(string[] paths)
    {
        IntPtr original = IntPtr.Zero, reduced = IntPtr.Zero, adminSid = IntPtr.Zero;
        var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Desktop = @"winsta0\default", Flags = 0x100 };
        var child = new Child();
        using (var desktop = new AcceptanceDesktop())
        try
        {
            Require(OpenProcessToken(GetCurrentProcess(), 0xF01FF, out original));
            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            var bytes = new byte[administrators.BinaryLength];
            administrators.GetBinaryForm(bytes, 0);
            adminSid = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, adminSid, bytes.Length);
            var disabled = new SidAttributes { Sid = adminSid, Attributes = 0 };
            Require(CreateRestrictedToken(original, 1, 1, ref disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out reduced)); // DISABLE_MAX_PRIVILEGE; Administrators becomes deny-only.
            int elevated;
            uint returned;
            Require(GetTokenInformation(reduced, 20, out elevated, 4, out returned) && returned == 4);
            if (elevated != 0) throw new InvalidOperationException("Reduced acceptance token is still elevated.");
            foreach (string path in paths)
                if (!Path.IsPathRooted(path) || path.IndexOf('"') >= 0) throw new InvalidOperationException("Invalid owned test path.");
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            var command = new StringBuilder("\"" + executable + "\" \"" + paths[0] + "\" \"" + paths[1] + "\" --restricted");
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10), GetCurrentProcess(), out startup.Input, 0, true, 2));
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out startup.Output, 0, true, 2));
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-12), GetCurrentProcess(), out startup.Error, 0, true, 2));
            Require(CreateProcessAsUser(reduced, executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out child));
            if (WaitForSingleObject(child.Process, 80000) != 0)
            {
                TerminateProcess(child.Process, 1);
                throw new InvalidOperationException("Restricted acceptance exceeded its deadline.");
            }
            uint code;
            Require(GetExitCodeProcess(child.Process, out code));
            if (code > 255) throw new InvalidOperationException("Restricted process exited with native status 0x" + code.ToString("X8") + ".");
            return (int)code;
        }
        finally
        {
            if (adminSid != IntPtr.Zero) Marshal.FreeHGlobal(adminSid);
            foreach (IntPtr handle in new[] { child.Thread, child.Process, startup.Input, startup.Output, startup.Error, reduced, original })
                if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    private static void Require(bool success)
    {
        if (!success) throw new InvalidOperationException("Restricted acceptance setup failed (Windows error " + Marshal.GetLastWin32Error() + ").");
    }
}
