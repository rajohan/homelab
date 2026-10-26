using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Homelab.Mira.Computer
{
    // Windows-only readiness and identity queries. This module contains no input,
    // screenshot, shell, launch, desktop-switch or permission-changing operation.
    internal static class NativeWindows
    {
        internal sealed class DesktopState
        {
            internal int SessionId;
            internal long ConnectedAt;
        }

        internal sealed class WindowIdentity
        {
            internal IntPtr Handle;
            internal int ProcessId;
            internal long StartedAt;
            internal string Executable;
            internal string Title;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SessionInfo
        {
            internal uint Id;
            internal int State;
            internal int Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)]
            internal string Station;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)]
            internal string User;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)]
            internal string Domain;
            internal long LogonTime;
            internal long ConnectTime;
            internal long DisconnectTime;
            internal long LastInputTime;
            internal long CurrentTime;
            internal uint IncomingBytes;
            internal uint OutgoingBytes;
            internal uint IncomingFrames;
            internal uint OutgoingFrames;
            internal uint IncomingCompressedBytes;
            internal uint OutgoingCompressedBytes;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SessionInfoEx
        {
            internal uint Level;
            internal SessionInfo Data;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime
        {
            internal uint Low;
            internal uint High;
            internal long Value { get { return ((long)High << 32) | Low; } }
        }

        private delegate bool EnumerateWindow(IntPtr window, IntPtr parameter);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateFile(string name, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, uint length, out uint returned);
        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int informationClass, out IntPtr value, out uint bytes);
        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr value);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumerateWindow callback, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        private static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

        // Unknown, locked, disconnected, Session 0 and secure desktops all fail closed.
        internal static DesktopState ReadyDesktop()
        {
            if (Environment.OSVersion.Version.Major < 10 || !Environment.UserInteractive)
                throw new InvalidOperationException("An interactive Windows 10 or later desktop is required.");
            uint session;
            if (!ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session) || session == 0)
                throw new InvalidOperationException("The current user session is unavailable.");
            IntPtr memory;
            uint bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, (int)session, 25, out memory, out bytes))
                throw new InvalidOperationException("The current user session cannot be verified (Windows error " + Marshal.GetLastWin32Error() + ").");
            SessionInfoEx info;
            try
            {
                if (bytes < Marshal.SizeOf(typeof(SessionInfoEx)))
                    throw new InvalidOperationException("The current user session returned incomplete state.");
                info = (SessionInfoEx)Marshal.PtrToStructure(memory, typeof(SessionInfoEx));
                if (!SessionReady(session, info.Level, info.Data.Id, info.Data.State, info.Data.Flags))
                    throw new InvalidOperationException("The desktop is locked or disconnected.");
            }
            finally { WTSFreeMemory(memory); }
            IntPtr desktop = OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero)
                throw new InvalidOperationException("The input desktop is unavailable.");
            try
            {
                var name = new StringBuilder(256);
                uint needed;
                if (!GetUserObjectInformation(desktop, 2, name, 512, out needed) ||
                    !String.Equals(name.ToString(), "Default", StringComparison.Ordinal))
                    throw new InvalidOperationException("The input desktop is not the normal user desktop.");
            }
            finally { CloseDesktop(desktop); }
            return new DesktopState { SessionId = (int)session, ConnectedAt = info.Data.ConnectTime };
        }

        // Local inventory for the consent form only; never return this list to the server.
        internal static List<WindowIdentity> Windows()
        {
            ReadyDesktop();
            var result = new List<WindowIdentity>();
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                if (result.Count >= 200) return false;
                try
                {
                    WindowIdentity target = Identity(window);
                    if (target.ProcessId != Process.GetCurrentProcess().Id && target.Title.Length > 0)
                        result.Add(target);
                }
                catch (Exception) { /* Inaccessible and elevated windows are not candidates. */ }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        // Re-read the exact native handle and process identity. Never find a replacement.
        internal static WindowIdentity Identity(IntPtr window)
        {
            uint pid;
            uint session;
            uint currentSession;
            if (window == IntPtr.Zero || window == GetDesktopWindow() || window == GetShellWindow() ||
                !IsWindowVisible(window) || GetWindowThreadProcessId(window, out pid) == 0 ||
                !ProcessIdToSessionId(pid, out session) ||
                !ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out currentSession) ||
                session != currentSession)
                throw new InvalidOperationException("The selected window is unavailable.");
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) throw new InvalidOperationException("The selected process is unavailable.");
            try
            {
                IntPtr token;
                if (!OpenProcessToken(process, 8, out token))
                    throw new InvalidOperationException("The selected process cannot be verified.");
                try
                {
                    int elevated;
                    uint returned;
                    if (!GetTokenInformation(token, 20, out elevated, 4, out returned) || returned != 4 || elevated != 0)
                        throw new InvalidOperationException("Elevated windows cannot be selected.");
                }
                finally { CloseHandle(token); }
                FileTime created, exited, kernel, user;
                uint length = 4096;
                var image = new StringBuilder((int)length);
                var nativeImage = new StringBuilder((int)length);
                const string localVolume = @"\Device\HarddiskVolume";
                if (!QueryFullProcessImageName(process, 1, nativeImage, ref length) ||
                    !nativeImage.ToString().StartsWith(localVolume, StringComparison.OrdinalIgnoreCase) ||
                    nativeImage.Length <= localVolume.Length || !Char.IsDigit(nativeImage[localVolume.Length]))
                    throw new InvalidOperationException("Select an application on a local disk.");
                length = 4096;
                if (!QueryFullProcessImageName(process, 0, image, ref length) ||
                    !GetProcessTimes(process, out created, out exited, out kernel, out user))
                    throw new InvalidOperationException("The selected process identity cannot be verified.");
                var title = new StringBuilder(513);
                GetWindowText(window, title, title.Capacity);
                return new WindowIdentity
                {
                    Handle = window, ProcessId = checked((int)pid), StartedAt = created.Value,
                    Executable = CanonicalExecutable(image.ToString()), Title = title.ToString()
                };
            }
            finally { CloseHandle(process); }
        }

        internal static bool SameWindow(WindowIdentity left, WindowIdentity right)
        {
            return left.Handle == right.Handle && left.ProcessId == right.ProcessId &&
                left.StartedAt == right.StartedAt &&
                String.Equals(left.Executable, right.Executable, StringComparison.OrdinalIgnoreCase);
        }

        internal static bool SessionReady(uint current, uint level, uint returned, int state, int flags)
        {
            return current > 0 && level == 1 && returned == current && state == 0 && flags == 1;
        }

        private static string CanonicalExecutable(string name)
        {
            using (SafeFileHandle file = CreateFile(name, 0x80, 7, IntPtr.Zero, 3, 0, IntPtr.Zero))
            {
                if (file.IsInvalid) throw new InvalidOperationException("The selected executable is unavailable.");
                var path = new StringBuilder(4096);
                uint length = GetFinalPathNameByHandle(file, path, (uint)path.Capacity, 0);
                if (length == 0 || length >= path.Capacity)
                    throw new InvalidOperationException("The selected executable path cannot be verified.");
                string value = path.ToString();
                if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value.Substring(4);
                if (value.Length < 4 || value[1] != ':' || value[2] != '\\' ||
                    !String.Equals(Path.GetExtension(value), ".exe", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Select a local Windows executable.");
                return value;
            }
        }
    }
}
