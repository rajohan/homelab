# Mira skills

The Automations page contains nine release-owned skill packages. Impeccable and
Intent contain the complete original upstream skill trees at the root-manifest
revisions. Their instructions, references, agent definitions, templates, helper
script sources, licenses and attribution are preserved as exact UTF-8 bytes with
their original repository-relative paths. The other seven packages remain
Homelab's existing native integration guidance.

## Original sources and Mira integration

The original entrypoints are
`.agents/skills/impeccable/SKILL.md` and
`skills/intent/SKILL.md`.
There are no replacement summaries of their workflows. Intent includes all 18
skills, their references and its six agent definitions. Impeccable includes all
files in its official agent skill directory, including init, critique, audit and
the accompanying references.

A separate integration note describes how the package is accessed in Mira. It is
metadata beside the original files, never inserted into or substituted for them.
The model reads the original entrypoint, selects the actual workflow and follows
its references. Resolve relative links from the current file; use the exact key
in the installed catalog. A CLI-style command in the documentation may invoke an
agent workflow or require an actual executable; these are distinct capabilities.

Bundling a script or agent definition does not execute it, register a specialist
agent or expose a native engine, hook or browser overlay. The current tool registry,
provider capabilities and permissions decide what can run. Use the original
documented fallback where applicable and report unsupported steps explicitly.
Never claim an upstream command ran because its documentation was read. No remote
skill installer runs during synchronization, builds, loading or update discovery.

Existing confirmed project context can be reused. Follow the relevant original
workflow, including its required artifacts and checks, without making the operator
repeat known facts or inventing missing inputs.

## Operator controls and access

View opens the original entrypoint and lets the operator inspect every bundled
file using the shared Markdown/code preview. Large files have explicit previous
and next sections; no source is silently shortened or reformatted in storage.

Each package has its own pause reason and optional timed resumption. Pausing
prevents new loads; it cannot remove text already loaded in a conversation.
Loading or enabling a package never enables integrations, expands tool access or
approves an external action. Native pinned Codex system-skill verification remains
unchanged, and both supported chat providers use the same Mira skill tools.

Activation and timed resumption require a fresh executor with the matching catalog
digest bound to its process identity. An old executor after rollback cannot inherit
a newer compatibility receipt. An offline or mismatched executor leaves preview
available but activation disabled. Deploy dashboard and executor from the same
reviewed release. Existing enabled controls remain enabled across a matching update;
new package controls start paused.

## Package and read contract

`apps/mira/src/server/skills/packages.json` is compiled into the application.
Each entry records its original entrypoint, complete text sources, version and
revision, separate integration note, required native tools, integration controls
and repository-context eligibility.

The root `package.json` under `config.skills` owns upstream version, exact
commit, official update feed, complete directory/file selection and source-content
fingerprint. It is the only dependency manifest. Runtime and the normal repository
check reject a bundle whose version, revision, entrypoint or original-content hash
does not match these pins.

Packages allow up to 256 files, 2 MiB per file and 8 MiB across the catalog. Only
regular losslessly decoded UTF-8 files are synchronized; symlinks and submodules
are unsupported. Keys are bounded relative paths with no traversal segments.
The API describes complete file sizes and SHA-256 digests and fingerprints the
original sources together with the separate integration metadata.

`mira_skills_list` returns entrypoints, file keys and current controls.
`mira_skill_read` defaults to the original entrypoint and returns at most
24,000 UTF-16 characters. Follow `nextOffset` until null before treating a
document as fully read; the returned hash always describes the entire file.
Every segment rechecks the exact package hash, owner's pause, original run scope
and lease. Loading remains passive: no filesystem discovery or code execution.

## Updates and verification

The existing hourly `homelab.dependencies` job discovers new official upstream
releases and shows current/available/unknown status on Updates. Its snapshot is
bound to the exact root manifest. Discovery does not silently install a release.

To incorporate an upstream release, update its root version and immutable revision,
then run `bun run skills:sync`. The script fetches only those explicit Git commits,
reads every file in the configured selections without checking out or executing
upstream code, and regenerates the bundle and its root content fingerprint.
It preserves original paths and bytes, including CRLF/BOM when present. Temporary
Git source directories are cleaned on success or failure. Review the original
content changes and separate integration notes together.

Run normal formatting, lint, types, both migration metadata checks and builds.
The existing check validates bundle bounds and content/pin consistency offline;
it does not depend on GitHub availability. Qualification should also compare the
generated files with the pinned upstream objects and reassemble paged reads.
There is no separate automated test suite or remote installer.
