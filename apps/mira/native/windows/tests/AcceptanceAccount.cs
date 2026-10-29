using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

// One random standard local account on the disposable runner, never a production
// identity. Its generated password stays in memory and is never passed to a child.
internal sealed class AcceptanceAccount : IDisposable
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo
    {
        internal string Name, Password;
        internal uint PasswordAge, Privilege;
        internal string Home, Comment;
        internal uint Flags;
        internal string Script;
    }
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint NetUserAdd(string server, uint level, ref UserInfo user, out uint parameter);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint NetUserDel(string server, string name);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    private readonly string name = "mira-" + Guid.NewGuid().ToString("N").Substring(0, 12);
    private bool created;
    internal IntPtr Token;
    internal SecurityIdentifier Sid;
    internal AcceptanceAccount()
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" ||
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
            throw new InvalidOperationException("Test accounts require disposable hosted Windows.");
        var user = new UserInfo { Name = name, Password = "Aa1!" + Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), Privilege = 1, Flags = 0x201 };
        uint parameter;
        if (NetUserAdd(null, 1, ref user, out parameter) != 0) throw new InvalidOperationException("The isolated standard account could not be created.");
        created = true;
        try
        {
            if (!LogonUser(name, ".", user.Password, 2, 0, out Token)) throw new InvalidOperationException("The isolated standard account could not log on.");
            using (var identity = new WindowsIdentity(Token)) Sid = identity.User;
            if (Sid == null) throw new InvalidOperationException("The isolated account identity is unavailable.");
        }
        catch { Dispose(); throw; }
        finally { user.Password = null; }
    }
    public void Dispose()
    {
        if (Token != IntPtr.Zero) { CloseHandle(Token); Token = IntPtr.Zero; }
        if (created)
        {
            if (NetUserDel(null, name) != 0) throw new InvalidOperationException("The isolated standard account could not be removed.");
            created = false;
        }
    }
}
