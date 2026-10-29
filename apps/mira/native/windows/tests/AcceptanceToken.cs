using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;

// Test-only launcher for one standard local account on the disposable hosted VM.
// The account and desktop permissions are removed after the child exits.
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
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string executable, StringBuilder command, uint flags, IntPtr environment, string directory, ref Startup startup, out Child child);

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
        IntPtr environment = IntPtr.Zero;
        var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Desktop = @"winsta0\default", Flags = 0x100 };
        var child = new Child();
        using (var account = new AcceptanceAccount())
        using (var desktop = new AcceptanceDesktop(account.Sid))
        try
        {
            int elevated;
            uint returned;
            Require(GetTokenInformation(account.Token, 20, out elevated, 4, out returned) && returned == 4);
            if (elevated != 0) throw new InvalidOperationException("The isolated standard account is elevated.");
            foreach (string path in paths)
                if (!Path.IsPathRooted(path) || path.IndexOf('"') >= 0) throw new InvalidOperationException("Invalid owned test path.");
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            var directory = new DirectoryInfo(Path.GetDirectoryName(executable));
            var access = directory.GetAccessControl();
            access.AddAccessRule(new FileSystemAccessRule(account.Sid, FileSystemRights.ReadAndExecute,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            directory.SetAccessControl(access);
            var scratch = directory.CreateSubdirectory("scratch");
            var scratchAccess = scratch.GetAccessControl();
            scratchAccess.AddAccessRule(new FileSystemAccessRule(account.Sid, FileSystemRights.Modify,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            scratch.SetAccessControl(scratchAccess);
            var entries = new System.Collections.Generic.SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in new[] { "SystemRoot", "WINDIR", "PATH", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS" })
            {
                string value = Environment.GetEnvironmentVariable(key);
                if (value != null) entries[key] = value;
            }
            entries["TEMP"] = entries["TMP"] = scratch.FullName;
            var block = new StringBuilder();
            foreach (var entry in entries) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
            environment = Marshal.StringToHGlobalUni(block.Append('\0').ToString());
            var command = new StringBuilder("\"" + executable + "\" \"" + paths[0] + "\" \"" + paths[1] + "\" --restricted");
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10), GetCurrentProcess(), out startup.Input, 0, true, 2));
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out startup.Output, 0, true, 2));
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-12), GetCurrentProcess(), out startup.Error, 0, true, 2));
            Require(CreateProcessWithTokenW(account.Token, 0, executable, command, 0x08000400, environment, directory.FullName, ref startup, out child));
            if (WaitForSingleObject(child.Process, 80000) != 0)
            {
                TerminateProcess(child.Process, 1);
                throw new InvalidOperationException("Standard-user acceptance exceeded its deadline.");
            }
            uint code;
            Require(GetExitCodeProcess(child.Process, out code));
            if (code > 255) throw new InvalidOperationException("Standard-user process exited with native status 0x" + code.ToString("X8") + ".");
            return (int)code;
        }
        finally
        {
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            foreach (IntPtr handle in new[] { child.Thread, child.Process, startup.Input, startup.Output, startup.Error })
                if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    private static void Require(bool success)
    {
        if (!success) throw new InvalidOperationException("Standard-user acceptance setup failed (Windows error " + Marshal.GetLastWin32Error() + ").");
    }
}
