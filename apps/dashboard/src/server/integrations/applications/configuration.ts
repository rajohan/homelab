import { applicationHostSchema } from "@homelab/contracts/applications";
import * as v from "valibot";

import { hostResourceKey } from "../../jobs/resources";

const secretName = v.pipe(v.string(), v.regex(/^HOMELAB_DASHBOARD_[A-Z0-9_]{1,100}$/));
const projectName = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/));
const labelName = v.pipe(v.string(), v.regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/));
const logLabels = v.record(
    labelName,
    v.pipe(v.string(), v.minLength(1), v.maxLength(160))
);
const legacyServiceSchema = v.strictObject({
    project: projectName,
    service: projectName,
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
});
const logConfiguration = v.strictObject({
    labels: v.pipe(
        logLabels,
        v.check(
            (labels) => Object.keys(labels).length > 0 && Object.keys(labels).length <= 8
        )
    ),
    serviceLabel: labelName,
    servicePrefix: v.optional(v.pipe(v.string(), v.maxLength(80)), ""),
    serviceValue: v.optional(v.picklist(["container", "service"])),
    projectLabel: v.optional(labelName),
    legacy: v.optional(
        v.strictObject({
            until: v.pipe(v.string(), v.isoTimestamp()),
            serviceLabel: labelName,
            services: v.pipe(
                v.array(legacyServiceSchema),
                v.minLength(1),
                v.maxLength(100)
            ),
        })
    ),
});
const schema = v.pipe(
    v.array(
        v.strictObject({
            id: applicationHostSchema,
            label: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
            endpoint: v.string(),
            projects: v.pipe(v.array(projectName), v.minLength(1), v.maxLength(50)),
            tls: v.optional(
                v.strictObject({
                    ca: secretName,
                    certificate: secretName,
                    key: secretName,
                })
            ),
            logs: v.optional(logConfiguration),
        })
    ),
    v.maxLength(20)
);
export type ApplicationTarget = v.InferOutput<typeof schema>[number] & {
    readonly controlHosts?: readonly string[];
};

/**
 * Coordinate Docker endpoints with the SSH hosts in the same deployment-owned source.
 * @param applications - Validated endpoints and project allowlists.
 * @param updates - Configured software targets; no access is inferred or granted.
 * @returns Docker targets holding every corresponding host lock as well as their endpoint lock.
 */
export function bindApplicationHosts(
    applications: readonly ApplicationTarget[],
    updates: readonly { readonly source: string; readonly host: string }[]
): readonly ApplicationTarget[] {
    return applications.map((application) => ({
        ...application,
        controlHosts: [
            ...new Set([
                new URL(application.endpoint).hostname,
                ...updates
                    .filter((target) => target.source === application.id)
                    .map((target) => target.host),
            ]),
        ].toSorted(),
    }));
}

/**
 * Derive the same deployment-owned host leases during admission and queued execution.
 * @param target - Docker endpoint with canonical SSH identities bound at configuration load.
 * @returns Unique opaque locks; different ports or proxy addresses cannot split host ownership.
 */
export function applicationHostResourceKeys(target: ApplicationTarget): string[] {
    return [
        ...new Set(
            [new URL(target.endpoint).hostname, ...(target.controlHosts ?? [])].map(
                (host) => hostResourceKey(host)
            )
        ),
    ];
}

/**
 * Validate trusted Docker endpoints and explicit project allowlists before startup.
 * @param value - JSON configuration containing only secret references, never values.
 * @param development - Explicit nonproduction mode, allowing loopback fixture servers.
 * @returns Unique host targets; HTTPS and mutual TLS are required outside fixtures.
 */
export function parseApplicationTargets(
    value: string | undefined,
    development = false
): readonly ApplicationTarget[] {
    const targets = v.parse(schema, JSON.parse(value ?? "[]") as unknown);
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
        throw new Error("Application host IDs must be unique");
    for (const target of targets) {
        const url = new URL(target.endpoint);
        const local =
            development &&
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (
            (!local && (url.protocol !== "https:" || !target.tls)) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
        )
            throw new Error(
                "Application endpoints require an exact HTTPS origin and scoped mutual TLS"
            );
        if (new Set(target.projects).size !== target.projects.length)
            throw new Error("Application project allowlists must be unique");
        if (
            target.logs?.serviceValue === "service" &&
            target.projects.length > 1 &&
            !target.logs.projectLabel
        )
            throw new Error(
                "Service logs covering multiple projects require a project log label"
            );
        if (target.logs && Object.hasOwn(target.logs.labels, target.logs.serviceLabel))
            throw new Error("Log service label conflicts with fixed host selectors");
        if (
            target.logs?.projectLabel &&
            (target.logs.projectLabel === target.logs.serviceLabel ||
                Object.hasOwn(target.logs.labels, target.logs.projectLabel))
        )
            throw new Error("Log project label conflicts with other selectors");
        const legacy = target.logs?.legacy;
        if (
            legacy &&
            target.logs &&
            (target.logs.serviceValue === "service" ||
                legacy.serviceLabel === target.logs.serviceLabel ||
                legacy.serviceLabel === target.logs.projectLabel ||
                Object.hasOwn(target.logs.labels, legacy.serviceLabel) ||
                Date.parse(legacy.until) > Date.now() ||
                legacy.services.some(
                    (entry) => !target.projects.includes(entry.project)
                ) ||
                new Set(
                    legacy.services.map((entry) => `${entry.project}/${entry.service}`)
                ).size !== legacy.services.length ||
                new Set(legacy.services.map((entry) => entry.value)).size !==
                    legacy.services.length)
        )
            throw new Error(
                "Legacy logs require unique project/service mappings and a past cutoff without conflicting labels"
            );
    }
    return targets;
}
