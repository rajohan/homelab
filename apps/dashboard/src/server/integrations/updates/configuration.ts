import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import nodePath from "node:path";

import { updateItemSchema } from "@homelab/contracts/updates";
import * as v from "valibot";

import { hostResourceKey } from "../../jobs/resources";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,47}$/));
const path = v.pipe(
    v.string(),
    v.maxLength(500),
    v.regex(/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/),
    v.check((value) => !value.split("/").includes(".."))
);
const argument = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(500),
    v.regex(/^[^\p{Cc}]+$/u)
);
const command = v.pipe(
    v.array(argument),
    v.minLength(1),
    v.maxLength(30),
    v.check((parts) => parts[0]?.startsWith("/") === true)
);
const environmentVariable = v.pipe(
    v.string(),
    v.regex(/^[A-Z_][A-Z0-9_]{0,99}$/),
    v.check(
        (name) =>
            !/^(?:COMPOSE_|DOCKER_|LD_|DYLD_|PYTHON|BASH|SHELL)/.test(name) &&
            !["PATH", "HOME", "ENV", "IFS", "LC_ALL", "LANG"].includes(name)
    )
);
const composeEnvironment = v.strictObject({
    command,
    variables: v.pipe(
        v.array(environmentVariable),
        v.minLength(1),
        v.maxLength(100),
        v.check((names) => new Set(names).size === names.length)
    ),
});
const service = v.pipe(
    v.string(),
    v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,99}\.service$/)
);
const nativeRecipe = v.variant("application", [
    v.strictObject({
        application: v.picklist(["bun", "node", "github-cli"]),
        directory: path,
        inventory: path,
        wrapper: v.optional(path),
        links: v.pipe(
            v.array(
                v.strictObject({
                    path,
                    member: v.picklist(["bun", "gh", "bin/node", "bin/npm", "bin/npx"]),
                })
            ),
            v.maxLength(3)
        ),
    }),
    v.strictObject({ application: v.literal("adguard-home"), binary: path, service }),
    v.strictObject({ application: v.literal("openclaw"), command, service }),
    v.strictObject({
        application: v.literal("codex"),
        prefix: path,
        node: path,
        npm: path,
        user: v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    }),
    v.strictObject({ application: v.literal("pve-exporter"), directory: path, service }),
    v.strictObject({
        application: v.picklist([
            "adguardhome-sync",
            "node-exporter",
            "smartctl-exporter",
            "blackbox-exporter",
            "alertmanager",
            "alloy",
            "loki",
            "traefik",
        ]),
        binary: path,
        service,
    }),
    v.strictObject({
        application: v.literal("victoriametrics"),
        component: v.picklist(["victoriametrics", "vmalert", "vmbackup"]),
        binary: path,
        service: v.optional(service),
    }),
    v.strictObject({
        application: v.literal("nextcloud"),
        directory: path,
        php: path,
        user: v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    }),
]);
const driverSchema = v.union([
    v.strictObject({ kind: v.literal("apt") }),
    v.strictObject({
        kind: v.literal("docker"),
        name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/)),
        project: identifier,
        service: identifier,
        directory: path,
        file: path,
        imageFile: path,
        trackingTag: updateItemSchema.entries.imageTag,
        namespaceDependents: v.optional(
            v.pipe(
                v.array(identifier),
                v.maxLength(30),
                v.check((names) => new Set(names).size === names.length)
            )
        ),
        healthChecks: v.optional(v.pipe(v.array(command), v.maxLength(10))),
        environment: v.optional(composeEnvironment),
    }),
    v.strictObject({
        kind: v.literal("native"),
        item: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        release: v.unwrap(updateItemSchema.entries.release),
        inspect: command,
        install: command,
        health: command,
    }),
    v.strictObject({
        kind: v.literal("native"),
        item: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        release: v.unwrap(updateItemSchema.entries.release),
        recipe: nativeRecipe,
        health: command,
    }),
]);
const targetSchema = v.strictObject({
    id: identifier,
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    source: identifier,
    host: v.pipe(v.string(), v.maxLength(253), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/)),
    user: v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    port: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
        22
    ),
    identityFile: path,
    knownHostsFile: path,
    sudo: v.optional(v.boolean(), false),
    driver: driverSchema,
});
export type UpdateTarget = v.InferOutput<typeof targetSchema>;

/**
 * Load the explicitly selected inline or packaged update-target configuration.
 * @param value - Optional legacy inline JSON; cannot be combined with a file.
 * @param file - Optional absolute path to a read-only deployment-owned JSON file.
 * @returns Validated targets with the same defaults and authority fingerprints.
 * @throws {Error} Configuration is ambiguous, unreadable, oversized or invalid.
 */
export function loadUpdateTargets(
    value: string | undefined,
    file: string | undefined
): UpdateTarget[] {
    if (file === undefined) return parseUpdateTargets(value);
    if (value !== undefined)
        throw new Error("Choose inline update targets or a target file, not both");
    if (!nodePath.isAbsolute(file) || file.includes("\0"))
        throw new Error("Update target file must use an absolute path");
    const limit = 1_048_576;
    const descriptor = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const metadata = fstatSync(descriptor);
        if (!metadata.isFile() || metadata.size > limit)
            throw new Error("Update target file must be a regular file within 1 MiB");
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(
                descriptor,
                buffer,
                length,
                buffer.length - length,
                null
            );
            if (count === 0) break;
            length += count;
        }
        if (length > limit) throw new Error("Update target file exceeds 1 MiB");
        const contents = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, length)
        );
        return parseUpdateTargets(contents);
    } finally {
        closeSync(descriptor);
    }
}

/**
 * Validate deployment-owned update targets independently of read-only publishers.
 * @param value - JSON with exact hosts, SSH trust files and fixed updater recipes.
 * @returns Unique targets; recipes and credentials are never accepted from the browser.
 */
export function parseUpdateTargets(value: string | undefined): UpdateTarget[] {
    const targets = v.parse(
        v.pipe(v.array(targetSchema), v.maxLength(100)),
        JSON.parse(value ?? "[]") as unknown
    );
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
        throw new Error("Update target IDs must be unique");
    const identities = targets.map((target) => {
        let software = "apt";
        if (target.driver.kind === "docker") software = target.driver.name;
        if (target.driver.kind === "native") software = target.driver.item;
        return JSON.stringify([target.source, target.driver.kind, software]);
    });
    if (new Set(identities).size !== identities.length)
        throw new Error("Software update target ownership must be unique");
    for (const target of targets) {
        const driver = target.driver;
        if (
            driver.kind === "docker" &&
            ![driver.file, driver.imageFile].every((file) =>
                file.startsWith(driver.directory + "/")
            )
        )
            throw new Error(
                "Compose update files must belong to the configured project directory"
            );
        if (
            target.driver.kind === "native" &&
            !("recipe" in target.driver) &&
            !target.driver.install.some((value) => value.includes("{version}"))
        )
            throw new Error(
                "Native updater recipes must install the exact approved version"
            );
        if (
            driver.kind === "native" &&
            "recipe" in driver &&
            driver.release !== driver.recipe.application
        )
            throw new Error("Native recipes must match their official release provider");
    }
    return targets;
}

/**
 * Bind update approval to the complete deployment target, including its execution recipe.
 * @param target - Validated, server-owned update target.
 * @returns Stable fingerprint; changing a recipe invalidates previous automatic consent.
 */
export function updateTargetRevision(target: UpdateTarget): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(target)).digest("hex");
}

/**
 * Share installation leases across recipes and source aliases on the same SSH host.
 * @param target - Deployment-owned host and integration metadata.
 * @returns Queue resources held by both individual and batched installations.
 */
export function updateResourceKeys(target: UpdateTarget): string[] {
    return [`updates:${target.source}`, hostResourceKey(target.host)];
}
