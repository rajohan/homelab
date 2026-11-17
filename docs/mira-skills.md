# Mira skills

The Automations page contains nine release-owned guidance packages: task tracking,
AgentMail, Daytona, GitHub, here.now, Moltbook, frontend improvement, Impeccable and
Intent. These adapt
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
Skill resume deadlines use a dedicated column while the legacy `until` stays null,
with a database constraint enforcing that separation. Older executors cannot select
these pauses for their generic resume loop.
An offline or mismatched executor leaves preview available but activation disabled.
Deploy the dashboard and executor from the same reviewed release.

## Package contract

`apps/mira/src/server/skills/packages.json` is compiled into the application. Each
entry records its adapter version, required native tools, integration
controls, repository-context eligibility and complete Markdown files. Upstream skill
versions, revisions, update feeds and source paths are owned by the root
`package.json` under `config.skills`; the catalog derives exact source links from it. The initial
packages contain `SKILL.md`; the format also supports companion Markdown files.
The API describes every file's byte size and SHA-256 digest, plus a complete package
digest. Reads require that exact package digest and a manifest-listed file key.
There is no host-path discovery, network fetch, script execution or remote installer.

Validation requires exactly one entry for every supported skill, a semantic version,
HTTPS source links, bounded tool/control names and safe relative Markdown keys.
Packages allow at most eight files, 48,000 UTF-8 bytes per file and 256 KiB across the
catalog. Source links identify the documentation used to author the installed instructions.
The existing updater checks the configured upstream release feeds automatically.

The model lists applicable guidance with `mira_skills_list` and loads it with
`mira_skill_read`. Every load rechecks the owner's current pause control. Improvement
runs and legacy runs without a captured kind can load only repository guidance.
The existing run lease, cancellation and tool receipt checks still apply. Loading a
file cannot grant a tool or authorize a privileged effect. Native pinned Codex system
skill verification remains unchanged.

## Updates and qualification

Changes to instructions, files or metadata use a Homelab PR, required checks, reviewed
release and the existing updater. Bump the package version when its guidance changes;
content and catalog hashes change with the installed bytes. The hourly
`homelab.dependencies` job reports available Impeccable and Intent updates on Updates,
using their root-manifest source versions. No manual upstream search is needed.
An available release is a candidate for updating the adaptation, not proof that new
guidance has already been installed. Update content and its source pin together. Never run a
downloaded skill installer as part of updating the catalog.

Qualification checks bundle bounds and hashes, owner isolation, exact-version reads,
pause and timed resume, executor mismatch/rollback, original automation scope and
expired leases. Use the existing repository checks and disposable development state;
the project does not maintain an automated test suite.

## Design workflow

The Impeccable and Intent packages are reviewed, passive adaptations pinned to exact
upstream commits, with their source links, attribution and licenses inside the bundle.
They are available to both supported chat providers through the existing skill tools.
Deploy the matching dashboard and Mira release, then enable each package in Skills.
New packages retain the same initially paused behavior as the existing catalog.

Intent supports product structure, navigation, user journeys, UX writing and recovery.
Impeccable supports visual critique, hierarchy, typography, layout, simplification and
responsive refinement. A whole-dashboard brief covers the shell and all relevant
routes together; implementation can proceed in coherent parts using shared components.
Read existing PRODUCT.md and DESIGN.md when present and record accepted decisions,
without turning the current design's accidental inconsistencies into requirements.

These adaptations do not install upstream CLIs, detector binaries, live overlays,
hooks or specialist agents. They do not add tools or authorize automatic design work.
Use ordinary language in Chat to request the workflow, for example: “Use Intent and
Impeccable to review the whole dashboard and improve its shared design.” Reuse the
established development application for visual feedback and retain normal review and
deployment requirements.
