import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";

const absolutePath = v.pipe(
    v.string(),
    v.minLength(2),
    v.maxLength(1024),
    v.regex(/^\/[A-Za-z0-9_./-]+$/),
    v.check((value) => !value.split("/").some((part) => part === "." || part === ".."))
);
const argumentsSchema = v.pipe(
    v.array(
        v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(2048),
            v.check((value) => !/[\0\r\n]/.test(value))
        )
    ),
    v.minLength(1),
    v.maxLength(40),
    v.check((value) => value[0]!.startsWith("/"))
);
const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,49}$/));
const unitName = v.pipe(
    v.string(),
    v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,150}\.service$/)
);
const targetSchema = v.strictObject({
    id: identifier,
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    connection: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    project: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
    directory: absolutePath,
    composeFile: absolutePath,
    stateDirectory: absolutePath,
    composeCommand: argumentsSchema,
    backupCommand: argumentsSchema,
    migrateCommand: argumentsSchema,
    environmentFile: v.optional(absolutePath),
    browserConfigFile: v.optional(absolutePath),
    browserProxyUnits: v.optional(
        v.pipe(v.array(unitName), v.minLength(1), v.maxLength(2))
    ),
    mira: v.boolean(),
    services: v.pipe(
        v.array(
            v.strictObject({
                name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
                app: v.picklist(["dashboard", "mira", "mira-browser-proxy"]),
            })
        ),
        v.minLength(1),
        v.maxLength(16)
    ),
    units: v.pipe(v.array(unitName), v.minLength(1), v.maxLength(16)),
});
export type ReleaseDeploymentTarget = v.InferOutput<typeof targetSchema>;

/**
 * Validate operator-owned self-deployment recipes without granting browser or model command selection.
 * @param value - Optional nonsecret deployment JSON; absence leaves self-deployment unavailable.
 * @param connections - Existing pinned SSH authorities used by ordinary updates.
 * @returns Explicit host recipes; Auth remains independently deployed.
 */
export function parseReleaseDeploymentTargets(
    value: string | undefined,
    connections: readonly UpdateTarget[]
): ReleaseDeploymentTarget[] {
    const targets = v.parse(
        v.pipe(v.array(targetSchema), v.maxLength(5)),
        JSON.parse(value ?? "[]") as unknown
    );
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
        throw new Error("Release deployment IDs must be unique");
    for (const target of targets) {
        if (
            new TextEncoder().encode(JSON.stringify(target)).byteLength > 16_384 ||
            !connections.some((connection) => connection.id === target.connection) ||
            new Set(target.services.map((service) => service.name)).size !==
                target.services.length ||
            new Set(target.units).size !== target.units.length ||
            (target.browserProxyUnits !== undefined &&
                (!target.browserConfigFile ||
                    target.browserProxyUnits.length >= target.units.length ||
                    new Set(target.browserProxyUnits).size !==
                        target.browserProxyUnits.length ||
                    target.browserProxyUnits.some(
                        (unit) => !target.units.includes(unit)
                    ))) ||
            !target.services.some((service) => service.app === "dashboard") ||
            (target.mira && !target.services.some((service) => service.app === "mira")) ||
            (target.browserConfigFile &&
                (!target.mira ||
                    !target.services.some(
                        (service) => service.app === "mira-browser-proxy"
                    ))) ||
            !target.composeFile.startsWith(target.directory + "/") ||
            target.composeFile === target.browserConfigFile ||
            [target.composeFile, target.browserConfigFile, target.environmentFile].some(
                (file) => file?.startsWith(target.stateDirectory + "/")
            )
        )
            throw new Error(
                "Release deployment requires explicit services, separate state and an existing connection"
            );
    }
    return targets;
}

/**
 * Bind release confirmation to the complete host recipe and its existing SSH authority.
 * @param target - Validated deployment-owned paths, services and fixed commands.
 * @param connections - Currently configured scoped SSH targets.
 * @returns A digest that changes when deployment authority or the recipe changes.
 */
export function releaseDeploymentRevision(
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[]
): string {
    const connection = connections.find((entry) => entry.id === target.connection);
    if (!connection) throw new Error("Release deployment connection is unavailable");
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ target, connection }))
        .digest("hex");
}
