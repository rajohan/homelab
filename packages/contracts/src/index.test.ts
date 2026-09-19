import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { systemStatusSchema } from "./index";

describe("system status contract", () => {
    test("rejects deployment claims that are not part of application capability status", () => {
        const result = v.safeParse(systemStatusSchema, {
            name: "Homelab",
            service: "dashboard",
            status: "ok",
            version: "0.1.0",
            phase: "operations",
            authenticationImplemented: true,
            integrationsImplemented: true,
            operationsConfigured: false,
            auth: { provider: "homelab", replacementEnabled: true },
        });

        expect(result.success).toBe(false);
    });
});
