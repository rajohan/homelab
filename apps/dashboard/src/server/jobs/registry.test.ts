import { describe, expect, test } from "bun:test";

import { maintenanceJob } from "./maintenance";
import {
    createJobRegistry,
    jobFingerprint,
    maximumIntegrationTimeoutMs,
} from "./registry";
import { hostResourceKey } from "./resources";

describe("job registration", () => {
    test("long deadlines are limited to bounded one-shot integration jobs", () => {
        const handler = maintenanceJob(30);
        const definition = {
            ...handler.definition,
            timeoutMs: maximumIntegrationTimeoutMs,
            admission: "integration" as const,
            retrySafe: false,
            attemptLimit: 1,
            intervalSeconds: null,
        };
        expect(createJobRegistry([{ ...handler, definition }]).size).toBe(1);
        for (const invalid of [
            { ...definition, timeoutMs: maximumIntegrationTimeoutMs + 1 },
            { ...handler.definition, timeoutMs: maximumIntegrationTimeoutMs },
            { ...definition, retrySafe: true },
            { ...definition, attemptLimit: 2 },
        ])
            expect(() =>
                createJobRegistry([{ ...handler, definition: invalid }])
            ).toThrow();
        expect(hostResourceKey("MAIN.internal")).toBe(hostResourceKey("main.internal"));
        expect(hostResourceKey("main.internal")).not.toBe(
            hostResourceKey("edge.internal")
        );
    });
    test("rejects duplicate actions and unsafe retry policies", () => {
        const handler = maintenanceJob(30);
        expect(() => createJobRegistry([handler, handler])).toThrow(
            "Invalid job registration"
        );
        expect(() =>
            createJobRegistry([
                { ...handler, definition: { ...handler.definition, retrySafe: false } },
            ])
        ).toThrow();
        expect(() =>
            createJobRegistry([
                { ...handler, definition: { ...handler.definition, timeoutMs: 0 } },
            ])
        ).toThrow();
        expect(() =>
            createJobRegistry([
                {
                    ...handler,
                    definition: { ...handler.definition, resourceKeys: ["x", "x"] },
                },
            ])
        ).toThrow();
    });
    test("validates empty payloads and stable policy fingerprints", () => {
        const definition = maintenanceJob(30).definition;
        expect(definition.validate({})).toEqual({});
        expect(() => definition.validate({ command: "unregistered" })).toThrow();
        expect(jobFingerprint(definition, {})).toBe(
            jobFingerprint({ ...definition }, {})
        );
        expect(jobFingerprint(definition, {})).not.toBe(
            jobFingerprint({ ...definition, timeoutMs: 5000 }, {})
        );
    });
});
