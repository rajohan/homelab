import { compileLogoutPresentation } from "./compileLogoutPresentation" with { type: "macro" };

const { style, views } = compileLogoutPresentation();
export const logoutStyleHash = new Bun.CryptoHasher("sha256")
    .update(style)
    .digest("base64");

/**
 * Serve the account frame with its provider-owned form and optional automatic submission.
 * @param step - The validated sign-out step.
 * @param form - The provider's protected form, when an active session can be ended.
 * @param script - The automatic submission script covered by the response's CSP hash.
 * @returns A standalone Identity document with its shared presentation inlined.
 */
export function logoutDocument(
    step: keyof typeof views,
    form = "",
    script?: string
): string {
    const { title, markup } = views[step];
    const submission = script ? `<script>${script}</script>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style></head><body>${form}${markup}${submission}</body></html>`;
}

/**
 * Present the successful sign-out state.
 * @returns The Identity document with the return-to-sign-in action.
 */
export function signedOutDocument(): string {
    return logoutDocument("complete");
}
