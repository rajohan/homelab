import * as v from "valibot";

export const hereNowSlugSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
);
const bindingSchema = v.strictObject({
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
    accountId: v.pipe(v.string(), v.uuid()),
});
export type HereNowBinding = v.InferOutput<typeof bindingSchema>;
export interface HereNowReadConfiguration extends HereNowBinding {
    apiKey: string;
    publishApiKey?: string | undefined;
}

/**
 * Parse the operator-owned account mapping shared by dashboard and executor.
 * @param environment - Explicit service settings; the dashboard needs no provider credential.
 * @returns Nonsecret account binding, or undefined before provisioning.
 */
export function hereNowBinding(
    environment: Readonly<Record<string, string | undefined>>
): HereNowBinding | undefined {
    const owner = environment.HOMELAB_MIRA_HERENOW_OWNER;
    const accountId = environment.HOMELAB_MIRA_HERENOW_ACCOUNT_ID;
    if (!owner && !accountId) return;
    const result = v.safeParse(bindingSchema, { owner, accountId });
    if (!result.success)
        throw new Error("HereNow requires an explicit owner and account ID.");
    return result.output;
}

/**
 * Parse an explicit HereNow account mapping without discovering credentials from legacy profiles.
 * @param environment - Service-owned environment; secrets stay outside the model child.
 * @returns A validated owner, expected account ID and read credential, or undefined before provisioning.
 */
export function hereNowReadConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): HereNowReadConfiguration | undefined {
    const binding = hereNowBinding(environment);
    const apiKey = environment.HOMELAB_MIRA_HERENOW_API_KEY;
    const publishApiKey = environment.HOMELAB_MIRA_HERENOW_PUBLISH_API_KEY || undefined;
    if (!apiKey && !publishApiKey) return;
    if (
        !binding ||
        !apiKey ||
        !/^[\u0021-\u007E]{20,2048}$/.test(apiKey) ||
        (publishApiKey !== undefined && !/^[\u0021-\u007E]{20,2048}$/.test(publishApiKey))
    )
        throw new Error(
            "HereNow requires an explicit owner, account ID and API credential."
        );
    return { ...binding, apiKey, ...(publishApiKey ? { publishApiKey } : {}) };
}

/**
 * Bind operator consent to an account identity independently of credential rotation.
 * @param configuration - Provisioned owner and expected here.now account.
 * @returns Nonsecret account fingerprint for control and runtime agreement.
 */
export function hereNowBindingHash(
    configuration: Pick<HereNowReadConfiguration, "owner" | "accountId">
): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([configuration.owner, configuration.accountId]))
        .digest("hex");
}
