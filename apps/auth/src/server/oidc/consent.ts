import type { IncomingMessage } from "node:http";

import { oidcConsentDecisionSchema, type OidcConsentDecision } from "@homelab/contracts";
import * as v from "valibot";

const inputSchema = v.union([v.strictObject({}), oidcConsentDecisionSchema]);

/**
 * Read a bounded JSON interaction request without accepting client-supplied scopes or targets.
 * @param request - The same-origin interaction POST owned by the provider listener.
 * @returns An explicit consent decision, or undefined when inspecting/continuing sign-in.
 * @throws {Error} The request has an unsupported media type, oversized body or invalid shape.
 */
export async function readConsentDecision(
    request: IncomingMessage
): Promise<OidcConsentDecision | undefined> {
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
        throw new Error("JSON interaction input is required");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let body = "";
    for await (const chunk of request as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > 4096) throw new Error("Interaction input is too large");
        body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    const input = v.parse(inputSchema, JSON.parse(body));
    return "decision" in input ? input : undefined;
}
