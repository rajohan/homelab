import type { UpdateItem } from "@homelab/contracts/updates";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

const version = v.pipe(
    v.string(),
    v.regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
);
const providers = {
    bun: {
        url: "https://api.github.com/repos/oven-sh/bun/releases/latest",
        field: "tag_name",
    },
    node: { url: "https://nodejs.org/dist/index.json", field: "version" },
    openclaw: { url: "https://registry.npmjs.org/openclaw/latest", field: "version" },
    "github-cli": {
        url: "https://api.github.com/repos/cli/cli/releases/latest",
        field: "tag_name",
    },
    "adguard-home": {
        url: "https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest",
        field: "tag_name",
    },
    "adguardhome-sync": {
        url: "https://api.github.com/repos/bakito/adguardhome-sync/releases/latest",
        field: "tag_name",
    },
    "node-exporter": {
        url: "https://api.github.com/repos/prometheus/node_exporter/releases/latest",
        field: "tag_name",
    },
    "smartctl-exporter": {
        url: "https://api.github.com/repos/prometheus-community/smartctl_exporter/releases/latest",
        field: "tag_name",
    },
    "blackbox-exporter": {
        url: "https://api.github.com/repos/prometheus/blackbox_exporter/releases/latest",
        field: "tag_name",
    },
    alertmanager: {
        url: "https://api.github.com/repos/prometheus/alertmanager/releases/latest",
        field: "tag_name",
    },
    victoriametrics: {
        url: "https://api.github.com/repos/VictoriaMetrics/VictoriaMetrics/releases/latest",
        field: "tag_name",
    },
    alloy: {
        url: "https://api.github.com/repos/grafana/alloy/releases/latest",
        field: "tag_name",
    },
    loki: {
        url: "https://api.github.com/repos/grafana/loki/releases/latest",
        field: "tag_name",
    },
    traefik: {
        url: "https://api.github.com/repos/traefik/traefik/releases/latest",
        field: "tag_name",
    },
    "pve-exporter": {
        url: "https://pypi.org/pypi/prometheus-pve-exporter/json",
        field: "version",
    },
    pgadmin: { url: "https://pypi.org/pypi/pgadmin4/json", field: "version" },
    nextcloud: {
        url: "https://api.github.com/repos/nextcloud/server/releases/latest",
        field: "tag_name",
    },
    "code-server": {
        url: "https://api.github.com/repos/coder/code-server/releases/latest",
        field: "tag_name",
    },
    codex: {
        url: "https://api.github.com/repos/openai/codex/releases/latest",
        field: "tag_name",
    },
} as const;

/**
 * Check only named official stable/current release feeds; reports cannot supply a URL.
 * @param provider - Code-registered release feed.
 * @param signal - Bounded collection deadline.
 * @param request - HTTP boundary, replaceable with loopback fixtures in tests.
 * @param installed - Required for Nextcloud's supported sequential release selection.
 * @returns Latest stable/current version, without upgrading or changing configured pins.
 */
export async function latestRelease(
    provider: NonNullable<UpdateItem["release"]>,
    signal: AbortSignal,
    request: typeof fetch = fetch,
    installed?: string
): Promise<string> {
    if (provider === "nextcloud") return nextcloudRelease(installed, signal, request);
    const source = providers[provider];
    const response = await request(source.url, {
        signal,
        redirect: "error",
        headers: { Accept: "application/json" },
    });
    const body = await readBoundedJson(response);
    const data =
        provider === "node"
            ? v.parse(
                  v.pipe(
                      v.array(v.object({ version })),
                      v.minLength(1),
                      v.maxLength(5000)
                  ),
                  body
              )[0]
            : body;
    const record = v.parse(v.record(v.string(), v.unknown()), data);
    const value = (
        provider === "pve-exporter" || provider === "pgadmin"
            ? v.parse(v.record(v.string(), v.unknown()), record.info)
            : record
    )[source.field];
    let normalized =
        typeof value === "string"
            ? value.replace(/^(?:bun|rust)-v/, "").replace(/^v/, "")
            : value;
    if (
        provider === "pgadmin" &&
        typeof normalized === "string" &&
        /^\d+\.\d+$/.test(normalized)
    )
        normalized += ".0";
    return v.parse(version, normalized).replace(/^v/, "");
}

async function nextcloudRelease(
    installed: string | undefined,
    signal: AbortSignal,
    request: typeof fetch
): Promise<string> {
    const current = v
        .parse(v.pipe(v.string(), v.regex(/^v?\d+\.\d+\.\d+$/)), installed)
        .replace(/^v/, "");
    const major = Number(current.split(".")[0]);
    const response = await request(
        "https://api.github.com/repos/nextcloud/server/releases?per_page=100",
        {
            signal,
            redirect: "error",
            headers: { Accept: "application/json" },
        }
    );
    const rows = v.parse(
        v.pipe(
            v.array(
                v.object({
                    tag_name: v.string(),
                    draft: v.boolean(),
                    prerelease: v.boolean(),
                })
            ),
            v.maxLength(100)
        ),
        await readBoundedJson(response)
    );
    const versions = rows
        .filter(
            (row) =>
                !row.draft && !row.prerelease && /^v?\d+\.\d+\.\d+$/.test(row.tag_name)
        )
        .map((row) => row.tag_name.replace(/^v/, ""))
        .toSorted((left, right) => Bun.semver.order(right, left));
    const branch = versions.find((value) => Number(value.split(".")[0]) === major);
    if (!branch)
        throw new Error(
            "Installed Nextcloud release series is not in the bounded stable catalog"
        );
    // Apply the current major's point releases before ever proposing the next major.
    if (Bun.semver.order(branch, current) > 0) return branch;
    return versions.find((value) => Number(value.split(".")[0]) === major + 1) ?? branch;
}

/**
 * Compare semantic release versions without confusing a locally newer build with an update.
 * @param installed - The observed local semantic version.
 * @param available - Version from the registered official feed.
 * @returns Current/available, or unknown for non-semantic local versions.
 */
export function compareRelease(
    installed: string,
    available: string
): UpdateItem["status"] {
    const current = v.safeParse(
        version,
        /^v?\d+\.\d+$/.test(installed) ? installed + ".0" : installed
    );
    const next = v.safeParse(version, available);
    if (!current.success || !next.success) return "unknown";
    return Bun.semver.order(
        current.output.replace(/^v/, ""),
        next.output.replace(/^v/, "")
    ) < 0
        ? "available"
        : "current";
}
