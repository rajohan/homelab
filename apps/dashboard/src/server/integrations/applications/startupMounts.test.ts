import { expect, test } from "bun:test";

import { startupCodePaths } from "./startup";
import { qualifyStartupMounts } from "./startupMounts";

test.each([
    ["/alias", "/etc/ld.so.conf.d/extra.conf", false, true],
    ["/alias", "/etc/ld.so.conf.d/nested/extra.conf", false, true],
    ["/alias", "/etc/ld.so.conf.debug/extra.conf", false, false],
    ["/alias", "/data/settings.conf", false, false],
    ["/entry", "/lib64/ld-linux-x86-64.so.2", true, true],
    ["/entry", "/lib/ld-musl-aarch64.so.1", true, true],
    ["/entry", "/usr/bin/time", true, true],
    ["/entry", "/usr/bin/prlimit", true, true],
    ["/entry", "/usr/bin/sleep", true, false],
] as const)(
    "resolved loader/resource alias %s -> %s",
    async (alias, target, executable, blocked) => {
        expect(
            await qualifyStartupMounts(
                executable ? [alias] : ["/vendor/server"],
                executable ? ["/custom"] : [alias],
                (name) =>
                    Promise.resolve({
                        mode: name === alias ? 134_217_728 : 2_147_483_648,
                        linkTarget: name === alias ? target : "",
                    })
            )
        ).toEqual([blocked]);
    }
);

test.each([
    ["/app/package.json", true],
    ["/app/manifest-alias", true],
    ["/data/settings.json", false],
    ["/etc/ld.so.preload", true],
    ["/etc", true],
] as const)("runtime project and loader inputs: %s", async (mount, blocked) => {
    const paths = startupCodePaths(["node"], ["."], "/app");
    const modes: Record<string, number> = {
        "/": 2_147_483_648,
        "/app": 2_147_483_648,
        "/data": 2_147_483_648,
        "/etc": 2_147_483_648,
        "/app/manifest-alias": 134_217_728,
    };
    expect(
        await qualifyStartupMounts(paths, [mount], (name) =>
            Promise.resolve({
                mode: modes[name] ?? 0,
                linkTarget: name === "/app/manifest-alias" ? "package.json" : "",
            })
        )
    ).toEqual([blocked]);
});

test("an ordinary program file does not qualify all its sibling data", async () => {
    expect(
        await qualifyStartupMounts(["/app/server"], ["/app/settings.json"], (name) =>
            Promise.resolve({
                mode: ["/", "/app"].includes(name) ? 2_147_483_648 : 0,
                linkTarget: "",
            })
        )
    ).toEqual([false]);
});

test.each([
    {
        links: { "/bin": "usr/bin", "/usr/bin/sh": "dash" },
        code: "/bin/sh",
        mount: "/data",
        blocked: false,
    },
    {
        links: { "/vendor/start": "../custom/start" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        links: { "/vendor/start": "../bridge/../start", "/bridge": "custom/dir" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: true,
    },
    {
        links: { "/vendor/start": "../custom/dir/../../usr/bin/sleep" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: false,
    },
    {
        links: { "/storage": "./custom" },
        code: "/custom/start",
        mount: "/storage",
        blocked: true,
    },
    {
        links: { "/vendor/start": "./start" },
        code: "/vendor/start",
        mount: "/data",
        blocked: true,
    },
    {
        links: { "/vendor/start": "next", "/vendor/next": "start" },
        code: "/vendor/start",
        mount: "/data",
        blocked: true,
    },
])("relative filesystem targets: %j", async ({ links, code, mount, blocked }) => {
    const targets: Record<string, string | undefined> = links;
    expect(
        await qualifyStartupMounts([code], [mount], (name) =>
            Promise.resolve({
                mode: targets[name] ? 134_217_728 : 2_147_483_648,
                linkTarget: targets[name] ?? "",
            })
        )
    ).toEqual([blocked]);
});

test("startup, cwd and PATH preserve link-before-parent traversal through qualification", async () => {
    const links: Record<string, string> = { "/alias": "/custom/dir" };
    const stat = (name: string) =>
        Promise.resolve({
            mode: links[name] ? 134_217_728 : 2_147_483_648,
            linkTarget: links[name] ?? "",
        });
    for (const paths of [
        startupCodePaths(["/alias/../start"], []),
        startupCodePaths(["./start"], [], "/alias/.."),
        startupCodePaths(["start"], [], "/", undefined, ["PATH=/alias/.."]),
        startupCodePaths(["/vendor/server"], [], "/", ["CMD", "/alias/../start"]),
    ]) {
        expect(paths).not.toBeNull();
        expect(paths?.some((name) => name.includes("/alias/../"))).toBe(true);
        expect(await qualifyStartupMounts(paths, ["/custom"], stat)).toEqual([true]);
    }
    expect(await qualifyStartupMounts(["/custom/start"], ["/alias/.."], stat)).toEqual([
        true,
    ]);
    expect(
        await qualifyStartupMounts(["/alias/../../outside"], ["/custom"], stat)
    ).toEqual([false]);
});

test("a symlink target's own parent traversal is resolved component by component", async () => {
    const links: Record<string, string> = {
        "/entry": "/alias/../start",
        "/alias": "/custom/dir",
    };
    expect(
        await qualifyStartupMounts(["/entry"], ["/custom"], (name) =>
            Promise.resolve({
                mode: links[name] ? 134_217_728 : 2_147_483_648,
                linkTarget: links[name] ?? "",
            })
        )
    ).toEqual([true]);
    expect(
        await qualifyStartupMounts(["/missing/../start"], ["/custom"], (name) =>
            Promise.resolve(
                name === "/missing" ? null : { mode: 2_147_483_648, linkTarget: "" }
            )
        )
    ).toEqual([true]);
});

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
        name: "relative directory response",
        links: { "/vendor": "relative" },
        code: "/vendor/start",
        mount: "/custom",
        blocked: false,
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
