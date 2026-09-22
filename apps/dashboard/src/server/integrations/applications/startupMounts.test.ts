import { expect, test } from "bun:test";

import { qualifyStartupMounts } from "./startupMounts";

test.each([
    {
        name: "direct image link",
        links: { "/vendor/start": "/custom/start" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "absolute link parent components",
        links: { "/vendor/start": "/vendor/../custom/start" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "absolute link dot components",
        links: { "/vendor/start": "/custom/./start" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "mount alias parent components",
        links: { "/storage": "/vendor/../custom/." },
        code: "/custom/start",
        mount: "/storage",
        blocked: true,
    },
    {
        name: "benign normalized image link",
        links: { "/vendor/start": "/vendor/../usr/bin/./sleep" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: false,
    },
    {
        name: "directory link",
        links: { "/vendor": "/custom" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "chained link",
        links: { "/vendor": "/bridge", "/bridge": "/custom" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "mount destination alias",
        links: { "/storage": "/custom" },
        code: "/custom/start",
        mount: "/storage",
        blocked: true,
    },
    {
        name: "benign image link",
        links: { "/bin": "/usr/bin" },
        code: "/bin/sleep",
        mount: "/custom",
        blocked: false,
    },
    {
        name: "link loop",
        links: { "/vendor": "/vendor" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        name: "noncanonical response",
        links: { "/vendor": "relative" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
])("filesystem qualification: $name", async ({ links, code, mount, blocked }) => {
    const metadata: Record<string, string | undefined> = links;
    expect(
        await qualifyStartupMounts([code], [mount], (name) =>
            Promise.resolve({
                mode: metadata[name] ? 134_217_728 : 2_147_483_648,
                linkTarget: metadata[name] ?? "",
            })
        )
    ).toEqual([blocked]);
});

test("missing or denied metadata cannot qualify mounted storage", async () => {
    expect(
        await qualifyStartupMounts(["/vendor/start"], ["/data"], () =>
            Promise.resolve(null)
        )
    ).toEqual([true]);
    expect(
        await qualifyStartupMounts(["/vendor/start"], ["/data"], () =>
            Promise.reject(new Error("private metadata"))
        )
    ).toEqual([true]);
    expect(
        await qualifyStartupMounts(null, ["/data"], () =>
            Promise.reject(new Error("must not read"))
        )
    ).toEqual([true]);
    expect(
        await qualifyStartupMounts(["/vendor/start"], [], () =>
            Promise.reject(new Error("must not read"))
        )
    ).toEqual([]);
});
