import { describe, expect, test } from "bun:test";

import { maintenanceJob } from "./maintenance";
import { createJobRegistry, jobFingerprint } from "./registry";

describe("job registration", () => {
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
