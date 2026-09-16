import { expect, test } from "bun:test";

import * as v from "valibot";

const mountSchema = v.object({
    type: v.string(),
    source: v.string(),
    target: v.string(),
    read_only: v.boolean(),
    bind: v.object({ create_host_path: v.boolean() }),
});
const authSchema = v.object({
    environment: v.record(v.string(), v.nullable(v.string())),
    volumes: v.array(mountSchema),
});
const composeSchema = v.object({ services: v.object({ auth: authSchema }) });

test("Compose mounts an read-only auth policy without requiring it for dashboard operations without the rejected JSON variable", async () => {
    const config = v.parse(
        composeSchema,
        Bun.YAML.parse(await Bun.file("deploy/compose.yaml").text())
    );
    const auth = config.services.auth;
    expect(auth.environment.HOMELAB_AUTH_ROUTES).toBeUndefined();
    expect(auth.environment.HOMELAB_AUTH_POLICY_FILE).toBe(
        "/etc/homelab-auth/access-policy.yml"
    );
    expect(auth.volumes).toEqual([
        {
            type: "bind",
            source: "${HOMELAB_AUTH_POLICY_FILE:-/etc/homelab-auth/access-policy.yml}",
            target: "/etc/homelab-auth/access-policy.yml",
            read_only: true,
            bind: { create_host_path: false },
        },
    ]);
});

test("Compose forwards all configurable session policy values to auth", async () => {
    const config = v.parse(
        composeSchema,
        Bun.YAML.parse(await Bun.file("deploy/compose.yaml").text())
    );
    for (const key of [
        "HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS",
        "HOMELAB_AUTH_SESSION_IDLE_TIMEOUT_SECONDS",
        "HOMELAB_AUTH_STEP_UP_MAX_AGE_SECONDS",
        "HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS",
        "HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS",
    ]) {
        expect(Object.hasOwn(config.services.auth.environment, key)).toBe(true);
        expect(config.services.auth.environment[key]).toBeNull();
    }
});
