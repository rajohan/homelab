# Mira skills

The Automations page contains seven release-owned guidance packages: task tracking,
AgentMail, Daytona, GitHub, here.now, Moltbook and frontend improvement. These adapt
selected legacy workflows to the existing native product tools. They do not copy
the entire legacy skill directory or its scripts and credential paths.

## Operator controls

View opens a bounded Markdown preview without enabling anything. Each skill starts
paused and supports its own reason and optional timed resumption. Pausing prevents
new guidance loads; it cannot remove text already loaded into a conversation.
Provider access and automatic-work permissions remain separate controls. Enabling a
skill never enables an integration, expands a tool set or approves an external action.

Activation and timed resumption require a fresh, ready executor with the same
catalog digest. Its heartbeat binds that digest to its process identity, so an old
executor after rollback cannot inherit a newer executor's compatibility receipt.
An offline or mismatched executor leaves preview available but activation disabled.
Deploy the dashboard and executor from the same reviewed release.

## Package contract

`apps/mira/src/server/skills/packages.json` is compiled into the application. Each
entry records its version, pinned source links, required native tools, integration
controls, repository-context eligibility and complete Markdown files. The initial
packages contain `SKILL.md`; the format also supports companion Markdown files.
The API describes every file's byte size and SHA-256 digest, plus a complete package
digest. Reads require that exact package digest and a manifest-listed file key.
There is no host-path discovery, network fetch, script execution or remote installer.

Validation requires exactly one entry for every supported skill, a semantic version,
HTTPS source links, bounded tool/control names and safe relative Markdown keys.
Packages allow at most eight files, 48,000 UTF-8 bytes per file and 256 KiB across the
catalog. Source links identify the documentation used to author the installed
instructions; they are not automatic update locations.

The model lists applicable guidance with `mira_skills_list` and loads it with
`mira_skill_read`. Every load rechecks the owner's current pause control. Improvement
runs and legacy runs without a captured kind can load only repository guidance.
The existing run lease, cancellation and tool receipt checks still apply. Loading a
file cannot grant a tool or authorize a privileged effect. Native pinned Codex system
skill verification remains unchanged.

## Updates and qualification

Changes to instructions, files or metadata use a Homelab PR, required checks, reviewed
release and the existing updater. Bump the package version when its guidance changes;
content and catalog hashes change with the installed bytes. Upstream announcements
are candidates for review, not proof of installed or qualified behavior. Never run a
downloaded skill installer as part of updating the catalog.

Tests cover bundle bounds and hashes, owner isolation, exact-version reads, pause and
timed resume, executor mismatch/rollback, original automation scope, expired leases,
preview without activation and the shared control dialogs. Development uses disposable
state. Production activation and live provider qualification remain separate pending
work in the [Mira delivery plan](mira.md).
