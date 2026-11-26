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
    private DesktopUpdateSession discovery;
    private Task<DesktopUpdateResult> discoveryResult;
    private TaskCompletionSource<bool> presenceStopped;
    private string connectionMessage = "Disconnected", updateMessage;
    private bool blocked, stopping, installing, closing, reconnect;
    internal event Action Changed;
    internal event Action ExitRequested;
    internal string Message { get { return updateMessage ?? connectionMessage; } }
    internal string ComputerId { get; private set; }
    internal string InstalledVersion { get; private set; }
    internal string AvailableVersion { get; private set; }
    internal bool ReconnectAfterUpdate { get { return reconnect; } }
    internal bool Updating { get { return updateMessage != null; } }
    internal bool Busy { get { return session != null || Updating; } }
    internal bool CanStart { get { return !Busy && !blocked && !closing; } }
    internal bool CanStop { get { return Busy && !stopping && !installing; } }
    internal bool CanUpdate { get { return maintenance != null && !Updating && !stopping && !blocked && !closing && (session == null || presenceStopped != null); } }

    internal DesktopConnection(string packageDirectory, string settingsDirectory, Action<bool> installation, Action<Action> invoke)
    {
        package = packageDirectory; settings = settingsDirectory; maintenance = installation; dispatch = invoke;
    }
    private void Publish(string message)
    {
        connectionMessage = message;
        if (Changed != null) Changed();
    }
    private void UpdateStatus(string message)
    {
        updateMessage = message;
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
            if (operation == "run") presenceStopped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
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
            blocked |= !result.Clean;
            if (result.ComputerId != null) ComputerId = result.ComputerId;
            if (result.PairingMissing) ComputerId = null;
            if (blocked) Publish("Process cleanup could not be confirmed. Close Homelab before reconnecting.");
            else if (operation == "pair") {
                paired = result.Success && !result.Stopped;
                Publish(paired ? "Paired" : "Pairing was not confirmed. Revoke the ticket in Settings before trying again.");
            } else if (operation == "forget") {
                if (result.Success) ComputerId = null;
                Publish(result.Success ? "Local pairing removed. Revoke the computer in Settings too." : "The local pairing could not be removed.");
            } else Publish(result.Stopped ? "Disconnected" : ComputerId == null ? "Pair this computer in Settings." : "Connection ended. Check your home network or Meshnet and reconnect.");
        } catch (ArgumentException error) { Publish(error.Message); }
        catch { blocked |= session != null; Publish("The computer connection could not start. Check the installation and private network."); }
        finally {
            if (current != null) current.Dispose();
            session = null;
            if (!Updating) stopping = false;
            var stopped = presenceStopped; presenceStopped = null;
            if (stopped != null) stopped.TrySetResult(!blocked);
            if (Changed != null) Changed();
            ExitIfIdle();
        }
        if (paired && !closing) await Start("run");
    }
    internal void Stop()
    {
        reconnect = false;
        if (!CanStop) return;
        stopping = true;
        if (Updating) UpdateStatus("Cancelling update…"); else Publish("Stopping…");
        if (session != null) session.Stop();
        if (download != null) download.Stop();
    }
    internal bool Close()
    {
        if (installing) return false;
        closing = true;
        if (discovery != null) discovery.Stop();
        if (!Busy && discovery == null) return true;
        Stop(); return false;
    }
    private void ExitIfIdle()
    {
        if (closing && !Busy && discovery == null && ExitRequested != null) ExitRequested();
    }
    internal async Task CheckAvailability()
    {
        if (!CanUpdate || discovery != null) return;
        var check = new DesktopUpdateSession(package, DesktopSettings.ServerOrigin, settings);
        discovery = check;
        try {
            discoveryResult = check.Run(true);
            var result = await discoveryResult;
            blocked |= !result.Clean;
            if (!result.Clean && !closing) Publish("Process cleanup could not be confirmed. Close Homelab before reconnecting.");
            if (!Updating && !closing) AvailableVersion = result.AvailableVersion;
        } catch { AvailableVersion = null; }
        finally {
            check.Dispose(); discovery = null; discoveryResult = null;
            if (Changed != null) Changed();
            ExitIfIdle();
        }
    }
    internal async Task UpdateApp(IWin32Window owner)
    {
        if (!CanUpdate) return;
        reconnect = false;
        UpdateStatus(AvailableVersion == null ? "Checking for updates…" : "Downloading Homelab " + AvailableVersion + "…");
        if (discovery != null) {
            discovery.Stop();
            try { await discoveryResult; } catch { }
        }
        await InstallAvailableUpdate(owner);
        if (reconnect && CanStart) await Start("run");
    }
    private async Task InstallAvailableUpdate(IWin32Window owner)
    {
        DesktopUpdateArtifact artifact = null;
        bool released = false, completed = false;
        string notice = null;
        string noticeTitle = "Homelab couldn’t update";
        try {
            if (closing || stopping || blocked) return;
            download = new DesktopUpdateSession(package, DesktopSettings.ServerOrigin, settings);
            var result = await download.Run();
            artifact = result.Artifact;
            blocked |= !result.Clean;
            if (blocked) { notice = "Homelab could not confirm process cleanup. Close the app before trying again."; return; }
            if (closing || stopping) return;
            AvailableVersion = artifact == null ? null : artifact.Version;
            if (result.UpToDate) { noticeTitle = "Homelab is up to date"; notice = "You’re using the latest verified Windows release."; return; }
            if (artifact == null) { notice = "Homelab couldn't get a verified update. Check your computer pairing and home network, then try again."; return; }
            UpdateStatus("Homelab " + artifact.Version + " is ready to install.");
            if (!MiraNotice.ConfirmUpdate(owner, artifact.Version, presenceStopped != null) || closing || stopping || blocked) return;
            artifact.RequireFresh();
            if (presenceStopped != null) {
                reconnect = true;
                UpdateStatus("Ending local computer access before updating…");
                var stopped = presenceStopped.Task;
                session.Stop();
                if (!await stopped) { notice = "Computer access could not be stopped cleanly. Close Homelab before updating."; return; }
                if (closing || stopping) return;
            }
            artifact.RequireFresh();
            installing = true; UpdateStatus("Installing Homelab " + artifact.Version + "…");
            maintenance(true); released = true;
            bool success = await Task.Run((Func<bool>)artifact.Install); completed = true;
            if (success) {
                InstalledVersion = artifact.Version; closing = true;
            } else notice = "Setup did not complete. Close other Homelab clients and try again.";
        } catch {
            blocked |= released && !completed;
            notice = blocked ? "The update could not be confirmed. Let setup finish, then reopen Homelab from Start." : "The verified update is no longer available. Check for updates again.";
        }
        finally {
            installing = false;
            if (released && completed && !closing) { try { maintenance(false); } catch { blocked = true; } }
            if (artifact != null) { try { artifact.Dispose(); } catch { blocked = true; } }
            if (download != null) { download.Dispose(); download = null; }
            if (blocked && !closing) Publish("Reopen Homelab after setup and process cleanup have finished.");
            if (notice != null && !closing && !stopping) MiraNotice.ShowNotice(owner, notice, noticeTitle);
            if (session == null) stopping = false;
            UpdateStatus(null);
            ExitIfIdle();
        }
    }
    public void Dispose()
    {
        if (session != null) session.Stop();
        if (download != null) download.Stop();
        if (discovery != null) discovery.Stop();
    }
}
