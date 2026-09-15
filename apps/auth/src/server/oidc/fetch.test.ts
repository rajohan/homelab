import { expect, test } from "bun:test";

import { createOidcFetch } from "./fetch";

test("OIDC transport only posts to exact registered endpoints and never follows redirects", async () => {
    let requests = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            requests += 1;
            return new URL(request.url).pathname === "/logout"
                ? new Response(null, { status: 204 })
                : Response.redirect(new URL("/unexpected", request.url).href, 307);
        },
    });
    const endpoint = new URL("/logout", server.url);
    const redirect = new URL("/redirect", server.url);
    const send = createOidcFetch([
        { client_id: "app", redirect_uris: [], backchannel_logout_uri: endpoint.href },
        {
            client_id: "redirect",
            redirect_uris: [],
            backchannel_logout_uri: redirect.href,
        },
    ]);
    try {
        const success = await send(endpoint, { method: "POST" });
        expect(success.status).toBe(204);
        const redirected = await send(redirect, { method: "POST" });
        expect(redirected.status).toBe(307);
        for (const input of [
            new URL("/unexpected", server.url),
            new URL(endpoint.href + "?other=1"),
        ])
            await rejected(send(input, { method: "POST" }));
        await rejected(send(new Request(endpoint.href, { method: "POST" })));
        await rejected(send(endpoint));
        await rejected(send(endpoint, { method: "GET" }));
        expect(requests).toBe(2);
    } finally {
        await server.stop(true);
    }
});

async function rejected(result: Promise<Response>): Promise<void> {
    await result.then(
        () => {
            throw new Error("An unregistered request was accepted");
        },
        (error: unknown) => {
            expect(String(error)).toContain("not registered");
        }
    );
}
