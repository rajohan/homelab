import assert from "node:assert/strict";
import { readdir, readlink } from "node:fs/promises";

import { Effect } from "effect";

import { openNativeBrowser } from "../browsing/native";

const executable = "/usr/lib/chromium/chromium";
async function chromiumProcesses() {
    const entries = await readdir("/proc");
    const processes = await Promise.all(
        entries
            .filter((name) => /^[0-9]+$/.test(name))
            .map(async (pid) => {
                try {
                    return (await readlink(`/proc/${pid}/exe`)) === executable
                        ? pid
                        : undefined;
                } catch {
                    return;
                }
            })
    );
    return processes.filter((pid) => pid !== undefined);
}
async function eventually(check: () => boolean | Promise<boolean>) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(25);
    }
    throw new Error(
        "The independent browser fixture did not confirm the expected state."
    );
}

/**
 * Qualify real tab images, trusted input, origin refusal and cleanup in an offline container.
 * @returns A content-free receipt; no personal profile, host desktop or external site is used.
 */
export async function qualifyBrowserFixture() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Use the isolated browser-test image for this qualification.");
    assert.deepEqual(await chromiumProcesses(), []);
    let text = "",
        count = 0,
        trusted = false,
        freshProfiles = 0,
        otherVisits = 0;
    const other = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
            otherVisits++;
            return new Response("Outside the observation ceiling");
        },
    });
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === "/leave") return Response.redirect(other.url.href);
            if (url.pathname === "/event" && request.method === "POST") {
                const data = (await request.json()) as {
                    text: string;
                    count: number;
                    trusted: boolean;
                };
                text = data.text;
                count = data.count;
                trusted = data.trusted;
                return new Response("ok");
            }
            if (url.pathname === "/") {
                if (!request.headers.get("cookie")) freshProfiles++;
                return new Response(
                    `<!doctype html><title>Mira isolated browser fixture</title>
                <label>Fixture text<input id="entry"></label><button id="counter">Count</button>
                <a href="/leave">Leave allowed origin</a><script>
                let clicks=0;
                const entry=document.getElementById('entry');
                function record(event){fetch('/event',{method:'POST',body:JSON.stringify({text:entry.value,count:clicks,trusted:event.isTrusted})});}
                entry.addEventListener('input',record);
                document.getElementById('counter').addEventListener('click',event=>{clicks++;record(event)});
                </script>`,
                    {
                        headers: {
                            "content-type": "text/html",
                            "set-cookie": "fixture=1; SameSite=Strict",
                        },
                    }
                );
            }
            return new Response("Not found", { status: 404 });
        },
    });
    const grant = {
        executable,
        origins: [server.url.origin],
        initialUrl: server.url.href,
        mode: "control",
    };
    const owner = AbortSignal.timeout(90_000);
    const open = () => openNativeBrowser(grant, owner);
    const active: Awaited<ReturnType<typeof open>>[] = [];
    try {
        const browser = await open();
        active.push(browser);
        let frame = await browser.observe(owner);
        assert.ok(frame.content.content[0]!.data.length > 100);
        const entry = frame.refs.find(
            (item) => item.role === "textbox" && item.label === "Fixture text"
        );
        assert.ok(entry);
        const input = {
            action: "type",
            observationId: frame.observationId,
            ref: entry.ref,
            text: "Isolated browser qualification",
            replace: true,
        };
        assert.deepEqual(await browser.act(input, owner), { effect: "unverified" });
        await eventually(() => text === input.text && trusted);
        frame = await browser.observe(owner);
        const button = frame.refs.find(
            (item) => item.role === "button" && item.label === "Count"
        );
        assert.ok(button);
        const click = {
            action: "click",
            observationId: frame.observationId,
            ref: button.ref,
        };
        await browser.act(click, owner);
        await eventually(() => count === 1 && trusted);
        await assert.rejects(browser.act(click, owner), /fresh browser observation/);
        await browser.close();
        await eventually(async () => {
            const processes = await chromiumProcesses();
            return processes.length === 0;
        });
        assert.equal(count, 1);

        const view = await openNativeBrowser({ ...grant, mode: "view" }, owner);
        active.push(view);
        frame = await view.observe(owner);
        await assert.rejects(
            view.act(
                {
                    action: "click",
                    observationId: frame.observationId,
                    ref: frame.refs.find((item) => item.role === "button")!.ref,
                },
                owner
            ),
            /view-only/
        );
        await view.close();
        assert.equal(count, 1);
        await eventually(async () => {
            const processes = await chromiumProcesses();
            return processes.length === 0;
        });

        const denied = await open();
        active.push(denied);
        await assert.rejects(denied.navigate(other.url.href, owner), /origin/);
        assert.equal(otherVisits, 0);
        await denied.close();

        const redirected = await open();
        active.push(redirected);
        frame = await redirected.observe(owner);
        const link = frame.refs.find(
            (item) => item.role === "link" && item.label === "Leave allowed origin"
        );
        assert.ok(link);
        // A page can navigate itself. The capability ceiling must refuse subsequent
        // observation/input; it is deliberately not described as a network firewall.
        try {
            await redirected.act(
                { action: "click", observationId: frame.observationId, ref: link.ref },
                owner
            );
        } catch {
            /* Navigation may invalidate the input result. */
        }
        await eventually(() => otherVisits > 0);
        await assert.rejects(redirected.observe(owner));
        await redirected.close();
        await eventually(async () => {
            const processes = await chromiumProcesses();
            return processes.length === 0;
        });
        assert.equal(freshProfiles, 4);
        assert.equal(count, 1);
        return {
            driver: "0.37.0",
            platform: "linux-chromium",
            tabImage: true,
            trustedType: true,
            trustedClick: true,
            viewOnly: true,
            replayDenied: true,
            deniedOrigin: true,
            redirectDenied: true,
            freshProfiles: true,
            stopped: true,
        };
    } finally {
        await Promise.all(active.map((browser) => browser.close()));
        await server.stop(true);
        await other.stop(true);
    }
}

if (import.meta.main) {
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: qualifyBrowserFixture,
            catch: (cause) =>
                new Error("Isolated browser qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
