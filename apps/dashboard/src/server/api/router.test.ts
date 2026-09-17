import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { appRouter } from "./router";
import { readSystemStatus, SystemStatusService } from "./system";

describe("dashboard system API", () => {
    test("reports implementation capabilities without claiming live infrastructure health", async () => {
        const result = await appRouter.createCaller({}).system.status();

        expect(result.service).toBe("dashboard");
        expect(result.authenticationImplemented).toBe(true);
        expect(result.auth).toEqual({ provider: "homelab" });
        expect(result.phase).toBe("operations");
    });

    test("the Effect service has a replaceable dependency boundary", async () => {
        const status = await appRouter.createCaller({}).system.status();
        const layer = Layer.succeed(SystemStatusService, {
            read: Effect.succeed({ ...status, version: "test-version" }),
        });

        const result = await Effect.runPromise(
            readSystemStatus.pipe(Effect.provide(layer))
        );
        expect(result.version).toBe("test-version");
    });
});
