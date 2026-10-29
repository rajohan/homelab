import * as v from "valibot";

import { openNativeBrowser } from "../browsing/native";

/**
 * Hold a real browser inside the disposable process-containment fixture.
 * @returns Completion on parent EOF; the external test can freeze this process to test forced cleanup.
 */
async function holdBrowserFixture() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Browser containment qualification requires its isolated image.");
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
            new Response(
                "<title>Containment fixture</title><button>Fixture button</button>",
                { headers: { "content-type": "text/html" } }
            ),
    });
    const owner = new AbortController();
    process.stdin.once("end", () => {
        owner.abort();
    });
    process.stdin.once("error", () => {
        owner.abort();
    });
    const browser = await openNativeBrowser(
        {
            executable: "/usr/lib/chromium/chromium",
            origins: [server.url.origin],
            initialUrl: server.url.href,
            mode: "view",
        },
        owner.signal
    );
    try {
        const frame = await browser.observe(owner.signal);
        if (frame.title !== "Containment fixture" || frame.width < 1)
            throw new Error("Browser fixture did not initialize.");
        await Bun.write(
            "/tmp/mira-browser-container-ready.json",
            JSON.stringify({ pid: process.pid, image: true })
        );
        let buffer = Buffer.alloc(0);
        for await (const chunk of process.stdin) {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            if (buffer.length > 64 * 1024) throw new Error("Fixture request too large.");
            const end = buffer.indexOf(10);
            if (end === -1) continue;
            if (end !== buffer.length - 1)
                throw new Error("Unexpected fixture requests.");
            const request = v.parse(
                v.strictObject({
                    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
                    body: v.strictObject({ operation: v.picklist(["observe", "hang"]) }),
                }),
                JSON.parse(buffer.toString("utf8"))
            );
            buffer = Buffer.alloc(0);
            if (request.body.operation === "hang") {
                await Bun.write(
                    "/tmp/mira-browser-transport-hang.json",
                    JSON.stringify({ id: request.id })
                );
                // Deliberately never answer. Only the host's container boundary can finish this fixture.
                await new Promise<void>(() => {});
            }
            const result = await browser.observe(owner.signal);
            process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
        }
    } finally {
        await browser.close();
        await server.stop(true);
    }
}

if (import.meta.main) await holdBrowserFixture();
