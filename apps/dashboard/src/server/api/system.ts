import { type SystemStatus, systemStatusSchema } from "@homelab/contracts";
import { Context, Effect, Layer } from "effect";
import * as v from "valibot";

import packageInformation from "../../../../../package.json";

export class SystemStatusService extends Context.Service<
    SystemStatusService,
    { readonly read: Effect.Effect<SystemStatus> }
>()("homelab/SystemStatusService") {}

export const SystemStatusLive = Layer.succeed(SystemStatusService, {
    read: Effect.sync(() =>
        v.parse(systemStatusSchema, {
            name: "Homelab",
            service: "dashboard",
            status: "ok",
            version: packageInformation.version,
            phase: "identity",
            authenticationImplemented: true,
            integrationsImplemented: false,
            auth: { provider: "homelab", replacementEnabled: false },
        })
    ),
});

export const readSystemStatus = Effect.gen(function* () {
    const service = yield* SystemStatusService;
    return yield* service.read;
});
