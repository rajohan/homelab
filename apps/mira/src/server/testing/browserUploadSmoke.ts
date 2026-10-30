import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

import { openNativeBrowser } from "../browsing/native";

async function eventually(check: () => boolean) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
        if (check()) return;
        await Bun.sleep(25);
    }
    throw new Error("The upload fixture did not confirm delivery.");
}

const directories = () =>
    readdir("/tmp").then((names) =>
        names.filter((name) => name.startsWith("homelab-browser-")).toSorted()
    );

/**
 * Prove native file assignment, delayed reading, live-origin refusal and session cleanup with Chromium.
 * @returns Content-free evidence from an offline disposable container; no personal attachment is read.
 */
export async function qualifyBrowserUploads() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Use the isolated browser-test image for upload qualification.");
    const before = await directories();
    const bytes = new TextEncoder().encode("Synthetic approved upload\n".repeat(4096));
    const expected = {
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        name: "Mira report.txt",
    };
    let received: typeof expected | undefined;
    let leave = false;
    let outside = 0;
    const other = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
            outside++;
            return new Response(
                '<title>Outside approved upload origin</title><label>Upload<input type="file"></label>',
                { headers: { "content-type": "text/html" } }
            );
        },
    });
    const site = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === "/state") return Response.json({ leave });
            if (url.pathname === "/uploaded" && request.method === "POST") {
                const content = new Uint8Array(await request.arrayBuffer());
                received = {
                    size: content.length,
                    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
                    name: request.headers.get("x-fixture-name") ?? "",
                };
                return new Response("ok");
            }
            return new Response(
                `<!doctype html><title>Browser upload fixture</title>
            <label>Approved file<input id="file" type="file"></label><button id="submit">Send selected file</button>
            <script>
            document.getElementById('submit').onclick=async()=>{const file=document.getElementById('file').files[0];if(file)await fetch('/uploaded',{method:'POST',headers:{'x-fixture-name':file.name},body:await file.arrayBuffer()});};
            setInterval(async()=>{if((await (await fetch('/state')).json()).leave)location.href=${JSON.stringify(other.url.href)};},50);
            </script>`,
                { headers: { "content-type": "text/html" } }
            );
        },
    });
    const owner = AbortSignal.timeout(45_000);
    const grant = {
        executable: "/usr/lib/chromium/chromium",
        origins: [site.url.origin],
        initialUrl: site.url.href,
        mode: "control",
        uploads: true,
    };
    const active: Awaited<ReturnType<typeof openNativeBrowser>>[] = [];
    try {
        const browser = await openNativeBrowser(grant, owner);
        active.push(browser);
        let frame = await browser.observe(owner);
        const input = frame.refs.find((item) => item.actions.includes("upload"));
        assert.ok(input, "The actual driver must expose a visible file-input ref.");
        const upload = { observationId: frame.observationId, ref: input.ref };
        assert.deepEqual(await browser.upload(upload, { ...expected, bytes }, owner), {
            effect: "unverified",
        });
        assert.equal(received, undefined);
        frame = await browser.observe(owner);
        const submit = frame.refs.find(
            (item) =>
                item.label === "Send selected file" && item.actions.includes("click")
        );
        assert.ok(submit);
        await browser.act(
            { action: "click", observationId: frame.observationId, ref: submit.ref },
            owner
        );
        await eventually(() => received !== undefined);
        assert.deepEqual(received, expected);
        await browser.close();
        assert.deepEqual(await directories(), before);

        const redirected = await openNativeBrowser(grant, owner);
        active.push(redirected);
        frame = await redirected.observe(owner);
        const stale = frame.refs.find((item) => item.actions.includes("upload"));
        assert.ok(stale);
        leave = true;
        await eventually(() => outside > 0);
        // The wrapper still holds the fresh ref; only native live-origin/node enforcement can refuse this.
        await assert.rejects(
            redirected.upload(
                { observationId: frame.observationId, ref: stale.ref },
                { ...expected, bytes },
                owner
            )
        );
        await redirected.close();
        assert.deepEqual(received, expected);
        assert.deepEqual(await directories(), before);
        return {
            assigned: true,
            delayedSubmissionVerified: true,
            digestVerified: true,
            redirectedUploadDenied: true,
            stagingRemoved: true,
        };
    } finally {
        await Promise.all(active.map((browser) => browser.close()));
        await site.stop(true);
        await other.stop(true);
    }
}
