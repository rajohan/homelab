import { type SystemStatus, systemStatusSchema } from "@homelab/contracts";
import { Context, Effect, Layer } from "effect";
import * as v from "valibot";

import packageInformation from "../../../../../package.json";

export class SystemStatusService extends Context.Service<
    SystemStatusService,
    { readonly read: Effect.Effect<SystemStatus> }
>()("homelab/SystemStatusService") {}

/**
 * Describe application capabilities and the current request's optional operations runtime.
 * @param operationsConfigured - Whether this server has an operations runtime, not a health claim.
 * @returns The status service without querying any optional backend.
 */
export function createSystemStatusLayer(operationsConfigured: boolean) {
    return Layer.succeed(SystemStatusService, {
        read: Effect.sync(() =>
            v.parse(systemStatusSchema, {
                name: "Homelab",
                service: "dashboard",
                status: "ok",
                version: packageInformation.version,
                phase: "operations",
                authenticationImplemented: true,
                integrationsImplemented: true,
                operationsConfigured,
                auth: { provider: "homelab" },
            })
        ),
    });
}

export const readSystemStatus = Effect.gen(function* () {
    const service = yield* SystemStatusService;
    return yield* service.read;
});
