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
const hostSchema = v.strictObject({
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
    localCodeConfigFile: v.optional(absolutePath),
    browserProxyUnits: v.optional(
        v.pipe(v.array(unitName), v.minLength(1), v.maxLength(3))
    ),
    mira: v.boolean(),
    services: v.pipe(
        v.array(
            v.strictObject({
                name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
                app: v.picklist(["auth", "dashboard", "mira", "mira-browser-proxy"]),
            })
        ),
        v.minLength(1),
        v.maxLength(16)
    ),
    units: v.pipe(v.array(unitName), v.minLength(1), v.maxLength(16)),
});
const authSchema = v.strictObject({
    ...v.omit(hostSchema, [
        "browserConfigFile",
        "localCodeConfigFile",
        "browserProxyUnits",
    ]).entries,
    mira: v.literal(false),
    services: v.pipe(
        v.array(
            v.strictObject({
                name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
                app: v.literal("auth"),
            })
        ),
        v.minLength(1),
        v.maxLength(16)
    ),
});
const targetSchema = v.strictObject({
    ...hostSchema.entries,
    auth: v.optional(authSchema),
});
export type ReleaseDeploymentHostTarget = v.InferOutput<typeof hostSchema>;
export type ReleaseDeploymentTarget = v.InferOutput<typeof targetSchema>;

/**
 * Validate operator-owned self-deployment recipes without granting browser or model command selection.
 * @param value - Optional nonsecret deployment JSON; absence leaves self-deployment unavailable.
 * @param connections - Existing pinned SSH authorities used by ordinary updates.
 * @returns Explicit host recipes, optionally coordinating an independent Auth deployment first.
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
            !target.services.some((service) => service.app === "dashboard") ||
            target.services.some((service) => service.app === "auth") ||
            (target.auth &&
                (target.auth.id === target.id ||
                    target.auth.connection === target.connection))
        )
            throw new Error("Auth requires a separate deployment host and recipe");
    }
    for (const target of targets.flatMap((entry) => deploymentHosts(entry))) {
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
            (target.mira && !target.services.some((service) => service.app === "mira")) ||
            (target.browserConfigFile &&
                (!target.mira ||
                    !target.services.some(
                        (service) => service.app === "mira-browser-proxy"
                    ))) ||
            (target.localCodeConfigFile && !target.browserConfigFile) ||
            !target.composeFile.startsWith(target.directory + "/") ||
            new Set(
                [
                    target.composeFile,
                    target.browserConfigFile,
                    target.localCodeConfigFile,
                    target.environmentFile,
                ].filter(Boolean)
            ).size !==
                [
                    target.composeFile,
                    target.browserConfigFile,
                    target.localCodeConfigFile,
                    target.environmentFile,
                ].filter(Boolean).length ||
            [
                target.composeFile,
                target.browserConfigFile,
                target.localCodeConfigFile,
                target.environmentFile,
            ].some((file) => file?.startsWith(target.stateDirectory + "/"))
        )
            throw new Error(
                "Release deployment requires explicit services, separate state and an existing connection"
            );
    }
    return targets;
}

/**
 * Enumerate fixed host recipes in their deployment order.
 * @param target - Dashboard recipe with an optional independently managed Auth host.
 * @returns Auth first, followed by the dashboard and its workers.
 */
export function deploymentHosts(
    target: ReleaseDeploymentTarget
): ReleaseDeploymentHostTarget[] {
    return target.auth ? [target.auth, target] : [target];
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
    const authorities = deploymentHosts(target).map((host) => {
        const connection = connections.find((entry) => entry.id === host.connection);
        if (!connection) throw new Error("Release deployment connection is unavailable");
        return connection;
    });
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify(
                target.auth
                    ? { target, authorities }
                    : { target, connection: authorities[0] }
            )
        )
        .digest("hex");
}
