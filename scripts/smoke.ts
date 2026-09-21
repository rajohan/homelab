import assert from "node:assert/strict";

import { BuiltRuntime } from "./testing/builtRuntime";

async function bounded<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out.`)),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function readPort(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                throw new Error(
                    "The built application closed before announcing its port."
                );
            pending += decoder.decode(chunk.value, { stream: true });
            assert.ok(pending.length < 16_384, "Unexpected application startup output.");
            const newline = pending.indexOf("\n");
            if (newline === -1) continue;
            const line = pending.slice(0, newline).trim();
            assert.match(
                line,
                /^SMOKE_PORT:\d+$/,
                "Unexpected application startup response."
            );
            const port = Number(line.slice("SMOKE_PORT:".length));
            assert.ok(port > 0 && port <= 65_535, "Invalid application listening port.");
            return port;
        }
    } finally {
        reader.releaseLock();
    }
}

async function get(origin: string, path: string): Promise<Response> {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin, "Smoke checks must not contact external services.");
    return fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Smoke-test the independently built applications using isolated child processes.
 * @returns Completion after health checks pass and all test processes stop.
 */
export async function main(): Promise<void> {
    const runtime = new BuiltRuntime();

    async function checkPackagedConfiguration(): Promise<void> {
        const source = await Bun.file(
            new URL("../apps/dashboard/config/update-targets.json", import.meta.url)
        ).arrayBuffer();
        const expected = new Bun.CryptoHasher("sha256").update(source).digest("hex");
        for (const app of ["auth", "dashboard"] as const) {
            const script =
                app === "dashboard"
                    ? `const data = await Bun.file('./config/update-targets.json').arrayBuffer();
if (new Bun.CryptoHasher('sha256').update(data).digest('hex') !== '${expected}') throw Error('Packaged configuration differs from source');
if (!Array.isArray(JSON.parse(new TextDecoder().decode(data)))) throw Error('Invalid packaged configuration');`
                    : `if (await Bun.file('./config/update-targets.json').exists()) throw Error('Auth must not package update authority');`;
            const child = runtime.spawn(app, ["--no-env-file", "-e", script], {
                NODE_ENV: "production",
            });
            const [code] = await bounded(
                Promise.all([
                    child.exited,
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                ]),
                15_000,
                `${app} packaged configuration`
            );
            assert.equal(
                code,
                0,
                "Deployment configuration must match only the dashboard artifact."
            );
        }
        console.info(
            "PASS: versioned update configuration is packaged unchanged only in dashboard/worker."
        );
    }

    async function checkStartupFailure(app: "auth" | "dashboard"): Promise<void> {
        const child = runtime.spawn(app, ["--no-env-file", "index.js"], {
            NODE_ENV: "production",
        });
        const [exitCode, stdout, stderr] = await bounded(
            Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]),
            15_000,
            `${app} missing-configuration rejection`
        );
        assert.equal(exitCode, 1);
        assert.equal(stdout, "");
        assert.ok(
            stderr.endsWith("\n"),
            "Startup diagnostics must end with a real newline."
        );
        // oidc-provider may also emit its documented Bun runtime warning.
        const lines = stderr.trimEnd().split("\n");
        const structured = lines.filter((line) => line.startsWith("{"));
        assert.equal(structured.length, 1, "Expected one structured startup failure.");
        const event: unknown = JSON.parse(structured[0] ?? "");
        assert.ok(record(event));
        assert.equal(event.service, app);
        assert.equal(event.event, "startup_failed");
        assert.equal(typeof event.hint, "string");
        assert.deepEqual(Object.keys(event).toSorted(), ["event", "hint", "service"]);
    }

    async function start(app: "auth" | "dashboard"): Promise<string> {
        const exportName = app === "auth" ? "startAuthServer" : "startDashboardServer";
        const child = runtime.spawn(
            app,
            [
                "--no-env-file",
                "-e",
                `const { ${exportName} } = await import('./index.js');
const server = await ${exportName}({ configuration: null, authentication: null, hostname: '127.0.0.1', port: 0, development: false });
console.log('SMOKE_PORT:' + server.port);`,
            ],
            { NODE_ENV: "production" }
        );
        const port = await bounded(
            Promise.race([
                readPort(child.stdout),
                child.exited.then((code) => {
                    throw new Error(
                        `The built ${app} application exited with code ${code}.`
                    );
                }),
            ]),
            15_000,
            `${app} startup`
        );
        return `http://127.0.0.1:${port}`;
    }

    async function checkDashboard(origin: string) {
        const response = await get(origin, "/");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("Content-Type") ?? "", /text\/html/i);
        assert.match(
            response.headers.get("Content-Security-Policy") ?? "",
            /frame-ancestors 'none'/
        );
        assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
        const html = await response.text();
        for (const path of ["/config/update-targets.json", "/update-targets.json"]) {
            const configuration = await get(origin, path);
            assert.doesNotMatch(
                configuration.headers.get("Content-Type") ?? "",
                /application\/json/i
            );
            assert.doesNotMatch(
                await configuration.text(),
                /identityFile|knownHostsFile|homelab-updater/
            );
        }
        assert.match(html, /<title>Homelab<\/title>/);
        assert.match(html, /id=["']root["']/);

        const scripts = [
            ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
        ].map((match) => match[1]);
        const styles = [...html.matchAll(/<link\b[^>]*>/gi)]
            .filter((match) => /\brel=["']stylesheet["']/i.test(match[0]))
            .map((match) => /\bhref=["']([^"']+)["']/i.exec(match[0])?.[1]);
        assert.ok(
            scripts.length > 0 && styles.length > 0,
            "The built document must link JavaScript and CSS assets."
        );
        for (const [kind, paths] of [
            ["javascript", scripts],
            ["css", styles],
        ] as const) {
            for (const path of paths) {
                assert.ok(path, "A built asset URL is missing.");
                const nestedUrl = new URL(path, new URL("/auth/declined", origin));
                const nestedAsset = await get(origin, nestedUrl.href);
                assert.equal(
                    nestedAsset.status,
                    200,
                    "Nested routes must resolve built assets."
                );
                assert.match(
                    nestedAsset.headers.get("Content-Type") ?? "",
                    kind === "css" ? /text\/css/i : /javascript|ecmascript/i
                );
                const asset = await get(origin, path);
                assert.equal(
                    asset.status,
                    200,
                    `The built ${kind} asset must be served.`
                );
                assert.match(
                    asset.headers.get("Content-Type") ?? "",
                    kind === "css" ? /text\/css/i : /javascript|ecmascript/i
                );
                const body = await asset.text();
                assert.ok(body.length > 0, "The built asset must not be empty.");
                assert.doesNotMatch(
                    body,
                    /192\.168\.1\.11|\/run\/secrets\/updates\/main/
                );
            }
        }

        const deepLink = await get(origin, "/auth/declined?returnTo=%2Fsettings");
        assert.equal(deepLink.status, 200);
        assert.match(await deepLink.text(), /id=["']root["']/);

        const apiResponse = await get(origin, "/api/trpc/system.status");
        assert.equal(apiResponse.status, 503);
        const missingApi = await get(origin, "/api/missing");
        assert.equal(missingApi.status, 503);
        console.info(
            "PASS: built dashboard HTML, linked assets, deep links and fail-closed private API."
        );
    }

    async function checkAuth(origin: string) {
        const response = await get(origin, "/health/live");
        assert.equal(response.status, 200);
        const status: unknown = await response.json();
        assert.ok(record(status));
        assert.equal(status.service, "auth");
        assert.equal(status.authenticationImplemented, true);
        for (const path of [
            "/.well-known/openid-configuration",
            "/authorize",
            "/api/authz/forward-auth",
        ]) {
            const unavailable = await get(origin, path);
            assert.equal(unavailable.status, 503);
            assert.equal(unavailable.headers.get("Set-Cookie"), null);
        }
        console.info(
            "PASS: independent built auth process and fail-closed identity endpoints."
        );
    }

    try {
        await checkPackagedConfiguration();
        await Promise.all([
            checkStartupFailure("dashboard"),
            checkStartupFailure("auth"),
        ]);
        console.info(
            "PASS: built applications reject missing production configuration with one redacted JSON log line."
        );
        const [dashboard, auth] = await Promise.all([start("dashboard"), start("auth")]);
        await Promise.all([checkDashboard(dashboard), checkAuth(auth)]);
    } finally {
        await runtime.close();
    }
}

if (import.meta.main) await main();
