import { applicationHostSchema } from "@homelab/contracts/applications";
import * as v from "valibot";

const secretName = v.pipe(v.string(), v.regex(/^HOMELAB_DASHBOARD_[A-Z0-9_]{1,100}$/));
const projectName = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/));
const labelName = v.pipe(v.string(), v.regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/));
const logLabels = v.record(
    labelName,
    v.pipe(v.string(), v.minLength(1), v.maxLength(160))
);
const logConfiguration = v.strictObject({
    labels: v.pipe(
        logLabels,
        v.check(
            (labels) => Object.keys(labels).length > 0 && Object.keys(labels).length <= 8
        )
    ),
    serviceLabel: labelName,
    servicePrefix: v.optional(v.pipe(v.string(), v.maxLength(80)), ""),
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
export type ApplicationTarget = v.InferOutput<typeof schema>[number];

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
        if (target.logs && Object.hasOwn(target.logs.labels, target.logs.serviceLabel))
            throw new Error("Log service label conflicts with fixed host selectors");
    }
    return targets;
}
