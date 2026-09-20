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
} as const;

/**
 * Check only named official stable/current release feeds; reports cannot supply a URL.
 * @param provider - Code-registered release feed.
 * @param signal - Bounded collection deadline.
 * @param request - HTTP boundary, replaceable with loopback fixtures in tests.
 * @returns Latest stable/current version, without upgrading or changing configured pins.
 */
export async function latestRelease(
    provider: NonNullable<UpdateItem["release"]>,
    signal: AbortSignal,
    request: typeof fetch = fetch
): Promise<string> {
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
    const value = v.parse(v.record(v.string(), v.unknown()), data)[source.field];
    return v
        .parse(version, typeof value === "string" ? value.replace(/^bun-v/, "") : value)
        .replace(/^v/, "");
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
    const current = v.safeParse(version, installed);
    const next = v.safeParse(version, available);
    if (!current.success || !next.success) return "unknown";
    return Bun.semver.order(
        current.output.replace(/^v/, ""),
        next.output.replace(/^v/, "")
    ) < 0
        ? "available"
        : "current";
}
