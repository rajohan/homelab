import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { systemStatusSchema } from "./index";

describe("system status contract", () => {
    test("does not claim that the isolated implementation replaced production", () => {
        const result = v.safeParse(systemStatusSchema, {
            name: "Homelab",
            service: "dashboard",
            status: "ok",
            version: "0.1.0",
            phase: "identity",
            authenticationImplemented: true,
            integrationsImplemented: false,
            auth: { provider: "homelab", replacementEnabled: true },
        });

        expect(result.success).toBe(false);
    });
});
