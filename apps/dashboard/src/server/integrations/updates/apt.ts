import { updateItemSchema, type UpdateItem } from "@homelab/contracts/updates";
import * as v from "valibot";

import type { UpdateTarget } from "./configuration";
import { updateSshArguments } from "./execution";

const program = `import apt, apt_pkg, datetime, json
from pathlib import Path
rows = []
for package in apt.Cache():
    if not package.is_installed:
        continue
    installed, candidate = package.installed, package.candidate
    rows.append({
        "id": "apt:" + package.fullname, "name": package.fullname, "kind": "os",
        "installed": installed.version, "available": candidate.version if candidate else None,
        "status": ("available" if apt_pkg.version_compare(candidate.version, installed.version) > 0 else "current") if candidate else "unknown",
        "held": package._pkg.selected_state == apt_pkg.SELSTATE_HOLD,
        "security": bool(candidate and package.is_upgradable and any("security" in origin.archive for origin in candidate.origins)),
    })
stamp = Path("/var/lib/apt/periodic/update-success-stamp")
indexes = [p.stat().st_mtime for p in Path("/var/lib/apt/lists").glob("*InRelease") if p.is_file()]
time = stamp.stat().st_mtime if stamp.is_file() else (min(indexes) if indexes else None)
print(json.dumps({"items": rows, "repositoryMetadataAt": datetime.datetime.fromtimestamp(time, datetime.timezone.utc).isoformat().replace("+00:00", "Z") if time is not None else None}))
`;
const observationSchema = v.strictObject({
    items: v.pipe(
        v.array(updateItemSchema),
        v.maxLength(5000),
        v.check(
            (items) =>
                items.every(
                    (item) =>
                        item.kind === "os" &&
                        /^apt:[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(item.id)
                ) && new Set(items.map((item) => item.id)).size === items.length
        )
    ),
    repositoryMetadataAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
});
export interface AptObservation {
    readonly items: UpdateItem[];
    readonly repositoryMetadataAt: string | null;
}

/**
 * Read the host's current installed packages, candidates and holds through its approved SSH target.
 * @param target - Explicit APT connection with pinned host trust and worker-only credentials.
 * @param signal - Worker cancellation and observation deadline.
 * @returns Validated local APT state; this never refreshes repositories or installs software.
 */
export async function readAptObservation(
    target: UpdateTarget,
    signal: AbortSignal
): Promise<AptObservation> {
    signal.throwIfAborted();
    if (target.driver.kind !== "apt")
        throw new Error("An APT observation requires an APT target");
    const process = Bun.spawn(updateSshArguments(target, program), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let output = "";
        let size = 0;
        for await (const bytes of process.stdout) {
            size += bytes.length;
            if (size > 2_000_000) throw new Error("APT observation exceeded its budget");
            output += decoder.decode(bytes, { stream: true });
        }
        output += decoder.decode();
        if ((await process.exited) !== 0)
            throw new Error("Current APT status could not be read");
        return v.parse(observationSchema, JSON.parse(output) as unknown);
    } finally {
        if (process.exitCode === null) process.kill();
        await process.exited;
    }
}
