import { expect, test } from "bun:test";
import path from "node:path";

import { computerWindowGrant, computerWindowManifest } from "./policy";

const grant = {
    executable: path.resolve("fixture-app"),
    pid: 123,
    windowId: "456",
    delivery: "background" as const,
};

test("window ceiling cannot capture the desktop, browse, launch processes or change permissions", () => {
    const policy = computerWindowManifest(grant);
    expect(policy.allow.tools).toEqual(["get_window_state", "click", "type_text"]);
    expect(policy.resources).toEqual({
        apps: [{ executable: grant.executable, windows: "all" }],
        desktop: { display: false },
    });
    expect(policy.expires_after).toBe("5m");
    expect(policy.idle_timeout).toBe("1m");
});

test("host grants require explicit delivery, canonical-shaped identities and safe wire integers", () => {
    expect(computerWindowGrant(grant)).toEqual(grant);
    for (const change of [
        { executable: "relative" },
        { pid: 0 },
        { windowId: "0" },
        { windowId: "1.0" },
        { windowId: "9007199254740993" },
        { windowId: "18446744073709551616" },
        { delivery: "auto" },
        { tools: ["shell"] },
    ])
        expect(() => computerWindowGrant({ ...grant, ...change })).toThrow();
});

test("desktop consent grants only explicit primary display observation and foreground input", async () => {
    const { computerGrant, computerManifest } = await import("./policy");
    const desktop = {
        scope: "desktop",
        displayId: "primary",
        delivery: "foreground",
        mode: "view",
    };
    expect(computerManifest(desktop)).toMatchObject({
        allow: { tools: ["get_desktop_state"] },
        resources: { apps: [], desktop: { display: true } },
    });
    expect(computerManifest({ ...desktop, mode: "control" }).allow.tools).toEqual([
        "get_desktop_state",
        "click",
        "type_text",
    ]);
    for (const invalid of [
        { ...desktop, displayId: "secondary" },
        { ...desktop, delivery: "background" },
        { ...desktop, executable: grant.executable },
        { ...grant, scope: "desktop" },
    ])
        expect(() => computerGrant(invalid)).toThrow();
    expect(() => computerWindowGrant(desktop)).toThrow();
});
