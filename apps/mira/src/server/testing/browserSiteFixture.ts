/**
 * Start the disposable loopback site that independently records trusted DOM input.
 * @returns The site server, owned and stopped by the qualification process.
 */
export function browserSiteFixture() {
    return Bun.serve({
        hostname: "127.0.0.1",
        port: 4173,
        fetch: async (request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/upload" && request.method === "POST") {
                const data = await request.formData();
                const file = data.get("attachment");
                if (!(file instanceof File))
                    return new Response("Missing file", { status: 400 });
                const bytes = new Uint8Array(await file.arrayBuffer());
                await Bun.write(
                    "/tmp/mira-browser-upload-proof.json",
                    JSON.stringify({
                        name: file.name,
                        size: bytes.length,
                        sha256: new Bun.CryptoHasher("sha256")
                            .update(bytes)
                            .digest("hex"),
                    })
                );
                return new Response("Stored fixture");
            }
            if (pathname === "/profile/save")
                return new Response(null, {
                    status: 302,
                    headers: {
                        location: "/profile/check",
                        "set-cookie":
                            "mira_fixture=saved; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict",
                    },
                });
            if (pathname === "/profile/check")
                return new Response(
                    `<title>${request.headers.get("cookie")?.includes("mira_fixture=saved") ? "Saved profile restored" : "Fresh profile"}</title><p>Disposable profile qualification</p>`,
                    { headers: { "content-type": "text/html" } }
                );
            if (new URL(request.url).pathname === "/event" && request.method === "POST") {
                const body = await request.text();
                if (body.length > 8192) return new Response("Too large", { status: 413 });
                await Bun.write("/tmp/mira-browser-worker-events.json", body);
                return new Response("ok");
            }
            return new Response(
                `<!doctype html><title>Worker fixture</title>
                <label>Fixture text<input id="entry"></label><button id="counter">Count</button>
                <form id="upload"><label>Fixture file<input type="file" name="attachment"></label><button>Submit fixture file</button></form>
                <script>
                document.getElementById('upload').addEventListener('submit',e=>{e.preventDefault();fetch('/upload',{method:'POST',body:new FormData(e.target)})});
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
