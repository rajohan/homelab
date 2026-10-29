/**
 * Start the disposable loopback site that independently records trusted DOM input.
 * @returns The site server, owned and stopped by the qualification process.
 */
export function browserSiteFixture() {
    return Bun.serve({
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
}
if (import.meta.main) browserSiteFixture();
