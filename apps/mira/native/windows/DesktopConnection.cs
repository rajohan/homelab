using System;
using System.Threading.Tasks;
using System.Windows.Forms;

// Windows-only connection/update lifecycle. Chat and all product state stay on the server.
internal sealed class DesktopConnection : IDisposable
{
    private readonly string package, settings;
    private readonly Action<bool> maintenance;
    private readonly Action<Action> dispatch;
    private DesktopSession session;
    private DesktopUpdateSession download;
    private bool blocked, stopping, installing, closing;
    internal event Action Changed;
    internal event Action ExitRequested;
    internal string Message { get; private set; }
    internal string ComputerId { get; private set; }
    internal bool Busy { get { return session != null || download != null || installing; } }
    internal bool CanStart { get { return !Busy && !blocked && !closing; } }
    internal bool CanStop { get { return Busy && !stopping && !installing; } }
    internal bool CanUpdate { get { return CanStart && maintenance != null; } }

    internal DesktopConnection(string packageDirectory, string settingsDirectory, Action<bool> installation, Action<Action> invoke)
    {
        package = packageDirectory; settings = settingsDirectory; maintenance = installation; dispatch = invoke;
        Message = "Disconnected";
    }
    private void Publish(string message)
    {
        Message = message;
        if (Changed != null) Changed();
    }
    internal async Task Start(string operation, string ticket = null)
    {
        if (!CanStart) return;
        DesktopSession current = null;
        bool paired = false;
        try {
            current = new DesktopSession(package, operation, DesktopSettings.ServerOrigin, ticket);
            session = current; stopping = false;
            Publish(operation == "pair" ? "Pairing…" : operation == "forget" ? "Removing pairing…" : "Connecting…");
            DesktopResult result = await current.Run(delegate(string state) {
                dispatch(delegate {
                    if (session != current || closing || stopping) return;
                    if (state.StartsWith("Paired: ", StringComparison.Ordinal)) ComputerId = state.Substring(8);
                    else if (state == "Pairing required.") ComputerId = null;
                    else { Publish(state); return; }
                    if (Changed != null) Changed();
                });
            });
            blocked = !result.Clean;
            if (result.ComputerId != null) ComputerId = result.ComputerId;
            if (result.PairingMissing) ComputerId = null;
            if (blocked) Publish("Process cleanup could not be confirmed. Close Mira before reconnecting.");
            else if (operation == "pair") {
                paired = result.Success && !result.Stopped;
                Publish(paired ? "Paired" : "Pairing was not confirmed. Revoke the ticket in Settings before trying again.");
            } else if (operation == "forget") {
                if (result.Success) ComputerId = null;
                Publish(result.Success ? "Local pairing removed. Revoke the computer in Settings too." : "The local pairing could not be removed.");
            } else Publish(result.Stopped ? "Disconnected" : ComputerId == null ? "Pair this computer in Settings." : "Connection ended. Check your home network or Meshnet and reconnect.");
        } catch (ArgumentException error) { Publish(error.Message); }
        catch { blocked = session != null; Publish("The computer connection could not start. Check the installation and private network."); }
        finally {
            if (current != null) current.Dispose();
            session = null; stopping = false;
            if (Changed != null) Changed();
            if (closing && ExitRequested != null) ExitRequested();
        }
        if (paired && !closing) await Start("run");
    }
    internal void Stop()
    {
        if (!CanStop) return;
        stopping = true; Publish("Stopping…");
        if (session != null) session.Stop();
        if (download != null) download.Stop();
    }
    internal bool Close()
    {
        if (installing) return false;
        closing = true;
        if (!Busy) return true;
        Stop(); return false;
    }
    internal async Task UpdateApp(IWin32Window owner)
    {
        if (!CanUpdate) return;
        DesktopUpdateSession current = null;
        DesktopUpdateArtifact artifact = null;
        bool released = false, completed = false;
        try {
            current = new DesktopUpdateSession(package, DesktopSettings.ServerOrigin, settings);
            download = current; stopping = false; Publish("Checking and downloading update…");
            var result = await current.Run(); artifact = result.Artifact; blocked = !result.Clean;
            if (blocked) { Publish("Update cleanup could not be confirmed. Close Mira before trying again."); return; }
            if (closing || stopping) { Publish("Update cancelled."); return; }
            if (artifact == null) { Publish("No verified update was downloaded. Check the server and pairing."); return; }
            artifact.RequireFresh(); installing = true; Publish("Installing Mira " + artifact.Version + "…");
            maintenance(true); released = true;
            bool success = await Task.Run((Func<bool>)artifact.Install); completed = true;
            if (success) {
                MessageBox.Show(owner, "Mira was updated. Open it again from Start; your pairing and sign-in are kept.", "Update installed", MessageBoxButtons.OK, MessageBoxIcon.Information);
                closing = true;
            } else Publish("Setup did not complete. Close other Mira clients and try again.");
        } catch { blocked = true; Publish("The update could not be confirmed. Let setup finish, then reopen Mira from Start."); }
        finally {
            installing = false;
            if (released && completed && !closing) { try { maintenance(false); } catch { blocked = true; } }
            if (artifact != null) { try { artifact.Dispose(); } catch { blocked = true; } }
            if (current != null) current.Dispose();
            download = null; stopping = false;
            if (Changed != null) Changed();
            if (closing && ExitRequested != null) ExitRequested();
        }
    }
    public void Dispose()
    {
        if (session != null) session.Stop();
        if (download != null) download.Stop();
    }
}
