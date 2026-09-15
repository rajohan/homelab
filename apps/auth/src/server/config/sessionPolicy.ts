import * as v from "valibot";

export interface AuthSessionPolicy {
    readonly maximumSeconds: number;
    readonly idleSeconds: number;
    readonly stepUpSeconds: number;
    readonly rememberMaximumSeconds: number;
    readonly rememberIdleSeconds: number;
}

export const defaultSessionPolicy: AuthSessionPolicy = Object.freeze({
    maximumSeconds: 43_200,
    idleSeconds: 3600,
    stepUpSeconds: 300,
    rememberMaximumSeconds: 2_592_000,
    rememberIdleSeconds: 604_800,
});

/**
 * Parse bounded session durations from nonsecret deployment configuration.
 * @param environment - The scoped auth environment; absent values preserve defaults.
 * @returns The consistent absolute, idle and step-up lifetimes in seconds.
 * @throws {Error} Durations are invalid, unbounded or conflict with one another.
 */
export function parseSessionPolicy(
    environment: Record<string, string | undefined>
): AuthSessionPolicy {
    function seconds(
        name: string,
        fallback: number,
        minimum: number,
        maximum: number
    ): number {
        return v.parse(
            v.pipe(
                v.string(),
                v.regex(/^[1-9]\d*$/),
                v.transform(Number),
                v.integer(),
                v.minValue(minimum),
                v.maxValue(maximum)
            ),
            environment[name] ?? String(fallback)
        );
    }
    const maximumSeconds = seconds(
        "HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS",
        defaultSessionPolicy.maximumSeconds,
        60,
        2_592_000
    );
    const idleSeconds = seconds(
        "HOMELAB_AUTH_SESSION_IDLE_TIMEOUT_SECONDS",
        defaultSessionPolicy.idleSeconds,
        60,
        maximumSeconds
    );
    const stepUpSeconds = seconds(
        "HOMELAB_AUTH_STEP_UP_MAX_AGE_SECONDS",
        defaultSessionPolicy.stepUpSeconds,
        30,
        Math.min(3600, idleSeconds)
    );
    const rememberMaximumSeconds = seconds(
        "HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS",
        defaultSessionPolicy.rememberMaximumSeconds,
        maximumSeconds,
        2_592_000
    );
    const rememberIdleSeconds = seconds(
        "HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS",
        defaultSessionPolicy.rememberIdleSeconds,
        idleSeconds,
        rememberMaximumSeconds
    );
    return {
        maximumSeconds,
        idleSeconds,
        stepUpSeconds,
        rememberMaximumSeconds,
        rememberIdleSeconds,
    };
}
