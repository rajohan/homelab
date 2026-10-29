using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Homelab.Mira.Computer;

// Disposable CI only: the administrator-only hosted desktop must permit the
// isolated test account SID after token reduction. Restore both original DACLs on exit.
internal sealed class AcceptanceDesktop : IDisposable
{
    private readonly IntPtr station;
    private readonly IntPtr desktop;
    private byte[] stationOriginal;
    private byte[] desktopOriginal;
    [DllImport("user32.dll")]
    private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor);

    internal AcceptanceDesktop(SecurityIdentifier user)
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
            throw new InvalidOperationException("Desktop acceptance requires disposable hosted Windows.");
        NativeWindows.ReadyDesktop();
        if (user == null) throw new InvalidOperationException("The isolated account identity is unavailable.");
        station = GetProcessWindowStation();
        desktop = OpenInputDesktop(0, false, 0x60001); // READ_CONTROL | WRITE_DAC | READOBJECTS
        if (station == IntPtr.Zero || desktop == IntPtr.Zero) throw new InvalidOperationException("Hosted desktop is unavailable.");
        try
        {
            stationOriginal = Read(station);
            desktopOriginal = Read(desktop);
            Grant(station, stationOriginal, user, 0xF037F); // WINSTA_ALL_ACCESS, including standard object rights.
            Grant(desktop, desktopOriginal, user, 0xF01FF); // DESKTOP_ALL_ACCESS for this one disposable test identity.
        }
        catch { Dispose(); throw; }
    }
    private static byte[] Read(IntPtr handle)
    {
        uint information = 4, needed;
        GetUserObjectSecurity(handle, ref information, null, 0, out needed);
        if (needed == 0 || needed > 65536) throw new InvalidOperationException("Invalid hosted desktop descriptor.");
        var bytes = new byte[needed];
        if (!GetUserObjectSecurity(handle, ref information, bytes, needed, out needed))
            throw new InvalidOperationException("Hosted desktop descriptor cannot be read.");
        return bytes;
    }
    private static void Grant(IntPtr handle, byte[] original, SecurityIdentifier sid, int mask)
    {
        var descriptor = new RawSecurityDescriptor(original, 0);
        if (descriptor.DiscretionaryAcl == null) throw new InvalidOperationException("Hosted desktop has no explicit DACL.");
        descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
            new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, mask, sid, false, null));
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        Set(handle, bytes);
    }
    private static void Set(IntPtr handle, byte[] descriptor)
    {
        uint information = 4;
        if (!SetUserObjectSecurity(handle, ref information, descriptor))
            throw new InvalidOperationException("Hosted desktop descriptor cannot be restored or set.");
    }
    public void Dispose()
    {
        try { if (desktopOriginal != null) Set(desktop, desktopOriginal); }
        finally
        {
            try { if (stationOriginal != null) Set(station, stationOriginal); }
            finally { if (desktop != IntPtr.Zero) CloseDesktop(desktop); }
        }
    }
}
