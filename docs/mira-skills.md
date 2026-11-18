# Mira skills

The Automations page contains nine release-owned skill packages. Impeccable and
Intent contain the complete original upstream skill trees at the root-manifest
revisions. Their instructions, references, agent definitions, templates, helper
script sources, licenses and attribution are preserved as exact UTF-8 bytes with
their original repository-relative paths. The other seven packages contain
Homelab's integration guidance with standard
SKILL.md name/description frontmatter. All nine packages use the same native Codex
installation, discovery and invocation path; there is no parallel skill engine.

## Original sources and Mira integration

The upstream entrypoints are
`.agents/skills/impeccable/SKILL.md` and
`skills/intent/SKILL.md`.
There are no replacement summaries of their workflows. Intent includes all 18
skills, their references and its six agent definitions. Impeccable includes all
files in its official agent skill directory, including init, critique, audit and
the accompanying references.

Homelab entrypoints live at `skills/<package-id>/SKILL.md` and are named
`homelab-<package-id>` in native discovery. The normal Mira build installs all skill trees beside the packaged
Codex executable at `runtime/skills/<package-id>/`, preserving their original
relative paths. On each work run, the executor verifies the installed files against
the compiled release and registers only the owner's enabled packages through
Codex's process-local `skills/extraRoots/set`. Native `skills/list` must discover
exactly the expected original names, paths and scopes, alongside the pinned Codex
system skills. Missing, modified, extra and linked entries are rejected.

Codex sees the original skills in its normal skill catalog and can select them for
matching work. Explicit mentions such as `$impeccable critique`, `$intent:intent`
and `$intent:evaluate` are sent as native skill inputs on turns and steering.
Unknown names or packages paused before the run do not select a native skill. The original entrypoint is
injected by Codex; no shortened replacement is substituted. Use the original
workflow, references and verification steps.

A separate host integration note maps native paths to `mira_skill_read` for
referenced files. Resolve references relative to the current file, remove its
package root and use the exact repository-relative key and package hash.
The empty workspace and private credential profile stay separate;
installation does not enable unrestricted shell access.

The release also installs Impeccable's original executable launcher and its native
engine at `scripts/bin/<os>-<arch>/impeccable`, the upstream documented sibling
location. The engine version and SHA-256 come from the unchanged upstream
`VERSION` and `engine-checksums.txt`, covered by the root manifest source pin.
Builds download only that artifact and fail on a missing pin, oversized response
or digest mismatch. Native discovery rechecks the installed engine. The existing
updater refreshes these pins with the skill source; there is no separate manual
engine update step or first-use installer.

Invoke original helper commands through an authorized execution tool with its
working directory set to the actual project checkout. A skill installation is not
a project checkout. Helpers do not gain credentials, host access or browser
permission from installation. Optional hooks, agents and live overlays retain
their original separate setup and tool requirements. The manual Codex installation
is supported upstream; this build does not run a remote npm installer. When a run
lacks an execution tool, use the original documented fallback and report it.

Existing confirmed project context can be reused. Follow the relevant original
workflow, including its required artifacts and checks, without making the operator
repeat known facts or inventing missing inputs.

## Operator controls and access

View opens the original entrypoint and lets the operator inspect every bundled
file using the shared Markdown/code preview. Large files have explicit previous
and next sections; no source is silently shortened or reformatted in storage.

Each package has its own pause reason and optional timed resumption. Every reader
call rechecks the current pause. Native discovery is selected per run; a pause
removes that package from the next run. A pause cannot erase instructions already
loaded in an active model turn. Changing enabled packages or release contents
rotates the provider thread before resuming so a stale native catalog is not reused.
Loading or enabling a package never enables integrations, expands tool access or
approves an external action. Native pinned Codex system-skill verification remains
unchanged. Native roots are process-local and never written into a shared profile;
login and connection checks receive no upstream skills.

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
generated files with the pinned upstream objects and reassemble paged reads. Native qualification uses a credential-free temporary
profile to verify discovery, thread setup, pause selection and rejection of altered
files; actual model work is verified separately after deployment.
There is no separate automated test suite or remote installer.

## Impeccable Live in development

The existing disposable development server supports `bun run dev --live`.
This opt-in allows only `http://localhost:8400` in the dashboard's script and
connection CSP, and keeps the applications on loopback. Ordinary dev
and production keep their existing policy. No production identity or database is
used. The committed `.impeccable/live/config.json` targets the real dashboard HTML
shell; helper tokens, journals and sessions are ignored by Git.

Build Mira normally (`bun run build mira`) to install the original pinned helper.
From the repository root, follow the installed Impeccable `live` skill:

```sh
apps/mira/dist/runtime/skills/impeccable/.agents/skills/impeccable/scripts/impeccable live --allow-missing-context --dev-url --auto-config --target apps/dashboard/src/index.html
```

Start `bun run dev --live` if the boot reports no running application, then repeat
the boot as upstream directs. The app URL is `http://localhost:3100`, not the helper
URL. For Main, use the configured browser bridge with
`bun run dev --live --browser-host=<outbound-Docker-bridge-gateway>` and
`HOMELAB_MIRA_BROWSER_DEV_HOST` on the connected browser proxy. This exposes only
3100, 3101 and 8400 on that private bridge for the lifetime of the dev process.
See `docs/mira-browser.md` for provisioning. An SSH tunnel remains optional for
a browser on another PC. Use the disposable account documented above to sign in yourself. The helper
must report port 8400; resolve a port conflict before opening the overlay rather
than broadening the CSP.

Keep the agent turn active and service the original foreground `live-poll` command.
The browser toolbar alone is not an active agent. After accepting or discarding,
follow upstream source cleanup and verification. On exit, run the original
`live-server stop` and stop the dev process this session started. Check that the
HTML injection was removed before committing or building production. Do not leave
a helper or temporary database running after the session. Live is a development
session, not a permanently enabled overlay on the deployed dashboard.
