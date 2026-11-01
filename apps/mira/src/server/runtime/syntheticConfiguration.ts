import * as v from "valibot";

const configurationSchema = v.strictObject({
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
    apiKey: v.pipe(
        v.string(),
        v.minLength(20),
        v.maxLength(2048),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
});
export type SyntheticConfiguration = v.InferOutput<typeof configurationSchema>;
export const syntheticBaseUrl = "https://api.synthetic.new/openai/v1";

/**
 * Read a server-only subscription credential with an explicit Homelab owner.
 * @param environment - Provisioned service environment; never discovers desktop or legacy credentials.
 * @returns A validated binding, or undefined until both settings are provisioned.
 */
export function syntheticConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): SyntheticConfiguration | undefined {
    const owner = environment.HOMELAB_MIRA_SYNTHETIC_OWNER;
    const apiKey = environment.HOMELAB_MIRA_SYNTHETIC_API_KEY;
    if (!owner && !apiKey) return;
    const result = v.safeParse(configurationSchema, { owner, apiKey });
    if (!result.success)
        throw new Error(
            "Synthetic requires an explicit owner and server API credential."
        );
    return result.output;
}
