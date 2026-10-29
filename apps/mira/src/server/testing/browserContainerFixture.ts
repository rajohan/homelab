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
    const stopped = Promise.withResolvers<void>();
    process.stdin.once("end", () => {
        owner.abort();
        stopped.resolve();
    });
    process.stdin.once("error", () => {
        owner.abort();
        stopped.resolve();
    });
    process.stdin.resume();
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
        await stopped.promise;
    } finally {
        await browser.close();
        await server.stop(true);
    }
}

if (import.meta.main) await holdBrowserFixture();
