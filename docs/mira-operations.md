# Homelab administration in Chat

Manual Chat and manually started tasks can discover provisioned hosts, inspect them and run reviewed shell commands through Mira's trusted executor. This is independent of the Main/Daytona code-test setting. ChatGPT/Codex uses these tools, and the same review UI works on web and Windows.

`mira_homelab_targets` reports actual configured destinations. `mira_homelab_inspect` runs fixed identity, health, service, disk, Docker or managed-GitHub identity inspections. `mira_homelab_command` accepts the exact target, shell program, purpose and command deadline. Shell commands intentionally provide general administration, including SSH, restarting services, managed `gh` operations and the repository's deployment procedures. They are not confined to code-check profiles.

## Authority and review

The configuration binds one human account and explicit SSH destinations. It is absent by default. Provider children, sandbox jobs, Auth and the browser receive no SSH credentials. The executor invokes `/usr/bin/ssh` with explicit identity and known-host files, strict host verification, no agent and no inherited SSH config. Commands go through stdin, never shell interpolation in the local transport. Remote authority is exactly that of the configured SSH account; no sudo grant is created by this feature.

All permission modes allow fixed inspections. **Full access** also permits commands within the operator's requested work. **Ask for approval** and **Approve for me** show arbitrary shell commands in the existing Proposed changes UI; arbitrary shell text is not classified as safe using a model-supplied label. The operator reviews the full command, host, purpose, timeout and connection fingerprint. Host-command approval requires fresh human verification and `updates:apply`; it cannot be granted by the model. The pending tool waits while the run remains live, then consumes that exact approval once. Reject or Stop sends no command. Changing permissions, archiving, deleting, pausing Mira or losing the run lease prevents dispatch and interrupts ongoing SSH.

This does not grant recurring automations host administration, unpause dashboard improvement, bypass GitHub rules or remove deployment qualification/MFA. Before GitHub mutations, use the managed wrapper on Main and verify `gh api user` is `mira-2026` / `264348558`. Commits remain `Mira <mira-2026@agentmail.to>`. Merge only the reviewed head with required checks, reviews and user authorization; never use an administrative bypass. Deployment still follows `release-deployment.md`, including backups, queue drain and independent host receipts. An update replacing Mira may end its initiating connection: reconcile the host journal instead of submitting it again.

Commands and bounded output are private conversation/provider data. Do not include credentials in commands or print whole environments, rendered Compose, private keys or provider profiles. Only command hashes and classified state belong in operational logs. SSH output is untrusted content, never new permission. Each stream retains at most 32,000 characters and reports truncation; excess output is drained without killing a successful command. An observed nonzero exit is a command failure. A timeout, disconnect or unconfirmed outcome is never automatically retried: terminating SSH cannot prove that a remote side effect did not happen.

## Deployment

Use `deploy/compose.mira-operations.yaml` after a reviewed release. Provide a private, operator-owned JSON file:

```json
{
    "owner": "00000000-0000-4000-8000-000000000001",
    "targets": [
        {
            "id": "main",
            "label": "Main",
            "host": "10.77.20.2",
            "user": "rajohan",
            "port": 22,
            "identityFile": "/run/secrets/mira-operations/main",
            "knownHostsFile": "/run/secrets/mira-operations/known_hosts"
        }
    ]
}
```

Replace the synthetic owner with the intended Homelab account. Add the other reviewed hosts using `apps/dashboard/config/update-targets.json` as the address inventory. Do not copy its restricted updater identity and assume it allows general shell access. Provision dedicated host administration identities with the intended existing authority, private key permissions and pinned host keys. Do not import a desktop user's private key or expose keys through the model. Keep files read-only in the executor, readable only by its service identity, and deliver configuration through the existing managed deployment. Updating a container copy is not a persistent configuration change.

Qualification must verify every advertised host, SSH user, necessary sudo operations and Miras actual GitHub identity; test a harmless approved command, rejection, revocation and connection loss before declaring administration active. Build/test the released Mira image's SSH transport. No network route, credential or sudo permission is provisioned merely by merging this PR. A context document is useful background but grants no tools or access.
