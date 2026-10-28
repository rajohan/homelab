using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Owns a fixed child and all descendants. No job or parent handles are inherited.
internal sealed class WorkerJob : IDisposable
{
    private IntPtr job;
    private IntPtr process;
    internal Stream Input;
    internal Stream Output;
    internal Stream Error;

    internal WorkerJob(string executable, string directory)
        : this(executable, directory, new string[0]) { }

    // Callers select the fixed sibling executable and locally validated arguments, never a shell.
    internal WorkerJob(string executable, string directory, string[] arguments)
    {
        IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        bool initialized = false;
        ProcessInformation child = new ProcessInformation();
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            ExtendedLimit limit = new ExtendedLimit();
            limit.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
            Require(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
            Pipe(out stdinRead, out stdinWrite, false);
            Pipe(out stdoutRead, out stdoutWrite, true);
            Pipe(out stderrRead, out stderrWrite, true);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Require(size.ToInt64() > 0 && size.ToInt64() < 65536);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, stdinRead);
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderrWrite);
            // Windows 10+ binds the job during process creation, before the initial thread runs.
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            environment = Marshal.StringToHGlobalUni(EnvironmentBlock());
            StartupInformationEx startup = new StartupInformationEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInformationEx));
            startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Startup.Input = stdinRead;
            startup.Startup.Output = stdoutWrite;
            startup.Startup.Error = stderrWrite;
            startup.Attributes = attributes;
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            Require(CreateProcess(executable, command,
                IntPtr.Zero, IntPtr.Zero, true, 0x08080404, environment, directory,
                ref startup, out child)); // NO_WINDOW | EXTENDED_STARTUPINFO | UNICODE_ENVIRONMENT | SUSPENDED
            process = child.Process;
            child.Process = IntPtr.Zero;
            bool assigned;
            Require(IsProcessInJob(process, job, out assigned) && assigned);
            Input = Stream(ref stdinWrite, FileAccess.Write);
            Output = Stream(ref stdoutRead, FileAccess.Read);
            Error = Stream(ref stderrRead, FileAccess.Read);
            Require(ResumeThread(child.Thread) == 1);
        }
        catch
        {
            Dispose();
            throw;
        }
        finally
        {
            Close(ref child.Thread);
            Close(ref child.Process);
            Close(ref stdinRead); Close(ref stdinWrite);
            Close(ref stdoutRead); Close(ref stdoutWrite);
            Close(ref stderrRead); Close(ref stderrWrite);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }

    internal bool Exited { get { return WaitForSingleObject(process, 0) == 0; } }

    internal uint ExitCode
    {
        get { uint code = 0; Require(Exited && GetExitCodeProcess(process, out code)); return code; }
    }

    private static string Quote(string value)
    {
        if (value == null || value.Length > 32767 || value.IndexOf('\0') >= 0) throw new ArgumentException();
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            quoted.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(character);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }

    internal bool StopAndConfirm()
    {
        if (job == IntPtr.Zero) return true;
        if (!TerminateJobObject(job, 1)) return false;
        Stopwatch wait = Stopwatch.StartNew();
        do
        {
            Accounting accounting;
            if (!QueryInformationJobObject(job, 1, out accounting,
                (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
            if (accounting.ActiveProcesses == 0) return true;
            Thread.Sleep(10);
        } while (wait.ElapsedMilliseconds < 1500);
        return false;
    }

    public void Dispose()
    {
        // Keep kill-on-close as a fallback even if explicit termination or accounting fails.
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
        Close(ref job);
        Close(ref process);
        if (Input != null) Input.Dispose();
        if (Output != null) Output.Dispose();
        if (Error != null) Error.Dispose();
    }

    private static string EnvironmentBlock()
    {
        var entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string key in new[] { "SystemRoot", "WINDIR", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "PATH" })
        {
            string value = Environment.GetEnvironmentVariable(key);
            if (value != null && value.IndexOf('\0') < 0) entries[key] = value;
        }
        var block = new StringBuilder();
        foreach (var entry in entries) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        return block.Append('\0').ToString();
    }

    private static FileStream Stream(ref IntPtr handle, FileAccess access)
    {
        var owned = new SafeFileHandle(handle, true);
        handle = IntPtr.Zero;
        try { return new FileStream(owned, access, 4096, false); }
        catch { owned.Dispose(); throw; }
    }
    private static void Pipe(out IntPtr read, out IntPtr write, bool parentReads)
    {
        SecurityAttributes security = new SecurityAttributes();
        security.Size = Marshal.SizeOf(typeof(SecurityAttributes));
        security.Inherit = true;
        Require(CreatePipe(out read, out write, ref security, 0));
        Require(SetHandleInformation(parentReads ? read : write, 1, 0));
    }
    private static void Require(bool result)
    {
        if (!result) throw new InvalidOperationException("Windows worker ownership could not be established.");
    }
    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal int Size; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        internal long ProcessTime, JobTime;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { internal ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        internal BasicLimit Basic;
        internal IoCounters Io;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInformation
    {
        internal int Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        internal short Show, ReservedSize;
        internal IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInformationEx { internal StartupInformation Startup; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool assigned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string directory, ref StartupInformationEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
