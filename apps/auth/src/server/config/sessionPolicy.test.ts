import { expect, test } from "bun:test";

import { defaultSessionPolicy, parseSessionPolicy } from "./sessionPolicy";

test("normal, remembered and step-up defaults remain independent", () => {
    expect(parseSessionPolicy({})).toEqual(defaultSessionPolicy);
    expect(defaultSessionPolicy.maximumSeconds).toBe(43_200);
    expect(defaultSessionPolicy.idleSeconds).toBe(3600);
    expect(defaultSessionPolicy.rememberMaximumSeconds).toBe(30 * 86_400);
    expect(defaultSessionPolicy.rememberIdleSeconds).toBe(7 * 86_400);
    expect(defaultSessionPolicy.stepUpSeconds).toBe(300);
});
test("all five session durations can be configured without source changes", () => {
    expect(
        parseSessionPolicy({
            HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS: "7200",
            HOMELAB_AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "900",
            HOMELAB_AUTH_STEP_UP_MAX_AGE_SECONDS: "120",
            HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS: "1209600",
            HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS: "172800",
        })
    ).toEqual({
        maximumSeconds: 7200,
        idleSeconds: 900,
        stepUpSeconds: 120,
        rememberMaximumSeconds: 1_209_600,
        rememberIdleSeconds: 172_800,
    });
});
test.each([
    { HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS: "0" },
    { HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS: "1.5" },
    { HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS: "Infinity" },
    { HOMELAB_AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "50000" },
    { HOMELAB_AUTH_STEP_UP_MAX_AGE_SECONDS: "3601" },
    { HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS: "3000000" },
    { HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS: "3600" },
    { HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS: "1800" },
    { HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS: "2592001" },
])("invalid session policies fail closed: %j", (environment) => {
    expect(() => parseSessionPolicy(environment)).toThrow();
});
