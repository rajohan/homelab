import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { appRouter } from "./api";
import { readSystemStatus, SystemStatusService } from "./system";

describe("dashboard system API", () => {
    test("reports the current boundary without claiming authentication is implemented", async () => {
        const result = await appRouter.createCaller({}).system.status();

        expect(result.service).toBe("dashboard");
        expect(result.authenticationImplemented).toBe(false);
        expect(result.auth).toEqual({ provider: "authelia", replacementEnabled: false });
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
