import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import * as v from "valibot";

import { openBrowserConnection } from "../browsing/connection";
import { prepareBrowserContainer } from "../browsing/container";
import { openBrowserWorker } from "../browsing/process";
import { openBrowserSession } from "../browsing/session";

/**
 * Exercise the fixed protocol through actual Docker pipes, native Chromium and independent site events.
 * @param image - Trusted local image tag to qualify; pinned to its ID before starting.
 * @param packaged - Start the synthetic site separately in the unchanged runtime image.
 * @returns A receipt after input, navigation, view-only and stale-reference checks remove every container.
 */
export async function qualifyBrowserWorker(
    image = "homelab-browser-worker-test:local",
    packaged = false
) {
    if (process.platform !== "linux")
        throw new Error("Use the Linux qualification host.");
    const socket = await realpath("/var/run/docker.sock");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mira-browser-worker-test-"));
    const execute = promisify(execFile);
    const docker = async (...args: string[]) => {
        const result = await execute(
            "/usr/bin/docker",
            ["--config", temporary, "--host", `unix://${socket}`, ...args],
            {
                env: { PATH: "/usr/bin:/bin", HOME: temporary },
                timeout: 10_000,
                maxBuffer: 64 * 1024,
            }
        );
        return result.stdout.trim();
    };
    try {
        const imageId = await docker("image", "inspect", image, "--format", "{{.Id}}");
        for (const mode of ["control", "view", "origin", "revocation"] as const) {
            const owner = new AbortController();
            let selected = "";
            const processId = crypto.randomUUID();
            const journalEvents: string[] = [];
            let revoked = false,
                released = false;
            const browser = await openBrowserSession(
                (sessionSignal) =>
                    openBrowserWorker(
                        { socketPath: socket, imageId },
                        {
                            origins: ["http://127.0.0.1:4173"],
                            initialUrl: "http://127.0.0.1:4173/",
                            mode: mode === "view" ? "view" : "control",
                        },
                        sessionSignal,
                        (config, signal) =>
                            openBrowserConnection(config, signal, {
                                prepare: async (input, abort) => {
                                    const lease = await prepareBrowserContainer(
                                        input,
                                        abort,
                                        undefined,
                                        {
                                            owner: processId,
                                            creating: () => {
                                                journalEvents.push("creating");
                                                return Promise.resolve();
                                            },
                                            created: (id) => {
                                                selected = id;
                                                journalEvents.push("created");
                                                return Promise.resolve();
                                            },
                                            starting: () => {
                                                journalEvents.push("starting");
                                                return Promise.resolve();
                                            },
                                            cleaning: () => {
                                                journalEvents.push("cleaning");
                                                return Promise.resolve();
                                            },
                                            cleaned: async (proof) => {
                                                assert.notEqual(
                                                    proof.kind,
                                                    "not-created"
                                                );
                                                if (proof.kind !== "not-created")
                                                    assert.equal(
                                                        proof.containerId,
                                                        selected
                                                    );
                                                await assert.rejects(
                                                    docker("inspect", selected)
                                                );
                                                journalEvents.push("cleaned");
                                            },
                                        }
                                    );
                                    assert.equal(lease.name, `mira-browser-${processId}`);
                                    selected = lease.id;
                                    if (!packaged) return lease;
                                    return {
                                        ...lease,
                                        start: async () => {
                                            await lease.start();
                                            const site = await Bun.file(
                                                new URL(
                                                    "browserSiteFixture.ts",
                                                    import.meta.url
                                                )
                                            ).text();
                                            await docker(
                                                "exec",
                                                "--detach",
                                                selected,
                                                "bun",
                                                "--no-env-file",
                                                "-e",
                                                site.replace(
                                                    "if (import.meta.main) browserSiteFixture();",
                                                    "browserSiteFixture();"
                                                )
                                            );
                                            const deadline = performance.now() + 5000;
                                            while (performance.now() < deadline) {
                                                try {
                                                    await docker(
                                                        "exec",
                                                        selected,
                                                        "bun",
                                                        "--no-env-file",
                                                        "-e",
                                                        "const response=await fetch('http://127.0.0.1:4173/');if(!response.ok)process.exit(1)"
                                                    );
                                                    return;
                                                } catch {
                                                    await Bun.sleep(25);
                                                }
                                            }
                                            throw new Error(
                                                "The independent browser fixture did not start."
                                            );
                                        },
                                    };
                                },
                            })
                    ),
                {
                    check: (scope) => {
                        if (revoked || (mode === "view" && scope === "control"))
                            throw new Error("Synthetic permission revoked.");
                        return Promise.resolve({ validForMs: 5000 });
                    },
                    release: async () => {
                        assert.ok(selected);
                        await assert.rejects(docker("inspect", selected));
                        assert.deepEqual(journalEvents, [
                            "creating",
                            "created",
                            "starting",
                            "cleaning",
                            "cleaned",
                        ]);
                        released = true;
                    },
                },
                owner.signal
            );
            const events = async (text: string, count: number) => {
                const deadline = performance.now() + 5000;
                while (performance.now() < deadline) {
                    try {
                        const value = v.parse(
                            v.strictObject({
                                text: v.string(),
                                count: v.number(),
                                trusted: v.boolean(),
                            }),
                            JSON.parse(
                                await docker(
                                    "exec",
                                    selected,
                                    "cat",
                                    "/tmp/mira-browser-worker-events.json"
                                )
                            )
                        );
                        if (value.text === text && value.count === count && value.trusted)
                            return;
                    } catch {
                        /* The event has not reached the independent fixture yet. */
                    }
                    await Bun.sleep(25);
                }
                throw new Error("The browser site did not confirm trusted input.");
            };
            try {
                let frame = await browser.observe(owner.signal);
                assert.equal(frame.title, "Worker fixture");
                assert.ok(frame.content.content[0]!.data.length > 100);
                if (mode === "revocation") {
                    revoked = true;
                    await browser.closed;
                    assert.equal(browser.signal.aborted, true);
                    await assert.rejects(browser.observe(owner.signal));
                } else if (mode === "origin") {
                    await assert.rejects(
                        browser.navigate("http://127.0.0.1:4174/", owner.signal)
                    );
                } else if (mode === "view") {
                    await assert.rejects(
                        browser.act(
                            {
                                action: "click",
                                observationId: frame.observationId,
                                ref: frame.refs.find((item) => item.role === "button")!
                                    .ref,
                            },
                            owner.signal
                        )
                    );
                } else {
                    const entry = frame.refs.find(
                        (item) => item.role === "textbox" && item.label === "Fixture text"
                    );
                    assert.ok(entry);
                    assert.deepEqual(
                        await browser.act(
                            {
                                action: "type",
                                observationId: frame.observationId,
                                ref: entry.ref,
                                text: "Private worker input",
                                replace: true,
                            },
                            owner.signal
                        ),
                        { effect: "unverified" }
                    );
                    await events("Private worker input", 0);
                    frame = await browser.observe(owner.signal);
                    const button = frame.refs.find(
                        (item) => item.role === "button" && item.label === "Count"
                    );
                    assert.ok(button);
                    const click = {
                        action: "click",
                        observationId: frame.observationId,
                        ref: button.ref,
                    };
                    assert.deepEqual(await browser.act(click, owner.signal), {
                        effect: "unverified",
                    });
                    await events("Private worker input", 1);
                    assert.deepEqual(
                        await browser.navigate(
                            "http://127.0.0.1:4173/next",
                            owner.signal
                        ),
                        { url: "http://127.0.0.1:4173/next" }
                    );
                    frame = await browser.observe(owner.signal);
                    assert.equal(frame.title, "Worker fixture");
                    await assert.rejects(browser.act(click, owner.signal));
                }
            } finally {
                await browser.close();
            }
            assert.equal(released, true);
            await assert.rejects(docker("inspect", selected));
        }
        return {
            durableJournal: true,
            fixedProtocol: true,
            supervisedRevocation: true,
            releaseAfterRemoval: true,
            realTabImages: true,
            trustedType: true,
            trustedClick: true,
            navigation: true,
            viewOnly: true,
            staleRefsDenied: true,
            foreignOriginDenied: true,
            containersRemoved: true,
        };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: () => qualifyBrowserWorker(),
            catch: (cause) =>
                new Error("Browser worker qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
