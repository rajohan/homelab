import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { browserDockerRequest, type BrowserDockerRequest } from "./docker";
import { browserEgressSchema } from "./egress";
import { browserProfileSchema } from "./profile";

const imageId = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
export const browserEngineConfigurationSchema = v.strictObject({
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId,
    egress: v.optional(browserEgressSchema),
    profile: v.optional(browserProfileSchema),
});
const inspection = v.object({
    Id: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    Image: imageId,
    Config: v.object({ Labels: v.record(v.string(), v.string()) }),
});

/**
 * Bind lifecycle operations to a canonical local Engine socket and immutable image.
 * @param input - Trusted host configuration, never model-selected connection details.
 * @param transport - Synthetic Docker transport used only by isolated tests.
 * @returns Fixed configuration, bounded requests and ownership-checked inspection.
 */
export async function browserEngine(input: unknown, transport?: BrowserDockerRequest) {
    const config = v.parse(browserEngineConfigurationSchema, input);
    const metadata = path.isAbsolute(config.socketPath)
        ? await lstat(config.socketPath)
        : null;
    if (
        !metadata?.isSocket() ||
        (await realpath(config.socketPath)) !== config.socketPath
    )
        throw new Error("The browser host requires a canonical local Docker socket.");
    const call = transport ?? browserDockerRequest(config.socketPath);
    return {
        config,
        call,
        inspect: async (reference: string, owner: string, expectedId?: string) => {
            const response = await call("GET", `/containers/${reference}/json`);
            if (response.status === 404) return null;
            if (response.status !== 200)
                throw new Error("Browser container inspection failed.");
            const found = v.parse(inspection, response.body);
            if (
                found.Config.Labels["io.homelab.mira.browser-owner"] !== owner ||
                found.Image !== config.imageId ||
                (expectedId && found.Id !== expectedId)
            )
                throw new Error("The browser container ownership does not match.");
            return found.Id;
        },
    };
}
