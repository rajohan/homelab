/**
 * Serve an offline synthetic site beside the real fixed browser worker.
 * @returns Completion after private stdin closes and the local fixture server stops.
 */
export async function browserWorkerFixture() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Use the disposable browser worker image.");
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 4173,
        fetch: async (request) => {
            if (new URL(request.url).pathname === "/event" && request.method === "POST") {
                const body = await request.text();
                if (body.length > 8192) return new Response("Too large", { status: 413 });
                await Bun.write("/tmp/mira-browser-worker-events.json", body);
                return new Response("ok");
            }
            return new Response(
                `<!doctype html><title>Worker fixture</title>
                <label>Fixture text<input id="entry"></label><button id="counter">Count</button>
                <script>
                let count=0;const entry=document.getElementById('entry');
                function record(event){fetch('/event',{method:'POST',body:JSON.stringify({text:entry.value,count,trusted:event.isTrusted})});}
                entry.addEventListener('input',record);
                document.getElementById('counter').addEventListener('click',event=>{count++;record(event)});
                </script>`,
                { headers: { "content-type": "text/html" } }
            );
        },
    });
    try {
        const worker = Bun.spawn(
            [
                process.execPath,
                "--no-env-file",
                "/source/apps/mira/src/server/browsing/workerCli.ts",
            ],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
        );
        process.exitCode = await worker.exited;
    } finally {
        await server.stop(true);
    }
}

if (import.meta.main) await browserWorkerFixture();
