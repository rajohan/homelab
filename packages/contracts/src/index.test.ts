import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { systemStatusSchema } from "./index";

describe("system status contract", () => {
    test("does not accept an implemented identity provider in the foundation", () => {
        const result = v.safeParse(systemStatusSchema, {
            name: "Homelab",
            service: "dashboard",
            status: "ok",
            version: "0.1.0",
            phase: "foundation",
            authenticationImplemented: true,
            integrationsImplemented: false,
            auth: { provider: "authelia", replacementEnabled: true },
        });

        expect(result.success).toBe(false);
    });
});
