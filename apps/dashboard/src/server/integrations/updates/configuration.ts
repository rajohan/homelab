import { updateItemSchema } from "@homelab/contracts/updates";
import * as v from "valibot";

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
    v.strictObject({ application: v.literal("adguard-home"), binary: path, service }),
    v.strictObject({ application: v.literal("openclaw"), command, service }),
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
    const host = new Bun.CryptoHasher("sha256")
        .update(target.host.toLowerCase())
        .digest("hex");
    return [
        `updates:${target.source}`,
        `updates:host:${host}`,
        ...(target.driver.kind === "docker" ? ["applications:inventory"] : []),
    ];
}
