import * as v from "valibot";

import type { ApplicationTarget } from "../integrations/applications/configuration";
import type { DockerDetail } from "../integrations/applications/docker";

/**
 * Build a complete synthetic container description with no relationship to a real daemon.
 * @param id - Stable hexadecimal container identity for the fixture.
 * @param name - Compose service label and display name.
 * @returns Mutable in-memory metadata used by isolated tests and the interactive preview.
 */
export function applicationFixtureDetail(id: string, name: string): DockerDetail {
    return {
        Id: id,
        Name: `/demo-${name}`,
        Image: `sha256:${"c".repeat(64)}`,
        Config: {
            Image: `example/${name}:1.0.0`,
            Labels: {
                "com.docker.compose.project": "demo",
                "com.docker.compose.service": name,
            },
        },
        State: {
            Status: "running",
            StartedAt: "2026-09-01T10:00:00Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            ExitCode: 0,
            Health: { Status: "healthy" },
        },
        NetworkSettings: {
            Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
            Networks: { demo_default: {} },
        },
        Mounts: [
            {
                Type: "volume",
                Source: `/synthetic/${name}`,
                Destination: "/data",
                RW: true,
            },
        ],
    };
}

/**
 * Serve synthetic Docker and Loki HTTP APIs on a random loopback-only port.
 * @param options - Optional observable latency and a separately selected unhealthy demo; automated tests remain immediate by default.
 * @returns Explicit fixture state, write history, endpoint and a mandatory cleanup callback.
 */
export function createApplicationFixture(
    options: {
        actionDelayMs?: number;
        healthDelayMs?: number;
        includeFailure?: boolean;
    } = {}
) {
    const database = applicationFixtureDetail("a".repeat(64), "database");
    const web = applicationFixtureDetail("b".repeat(64), "web");
    web.Config.Labels = {
        ...web.Config.Labels,
        "com.docker.compose.depends_on": "database:service_healthy:false",
    };
    const containers = new Map([database, web].map((detail) => [detail.Id, detail]));
    const readiness = new Map<string, number>();
    const lifetime = new AbortController();
    const failureId = "d".repeat(64);
    if (options.includeFailure) {
        const failure = applicationFixtureDetail(failureId, "health-failure");
        failure.Config.Labels = {
            ...failure.Config.Labels,
            "com.docker.compose.project": "failure-demo",
        };
        failure.State.Status = "exited";
        containers.set(failureId, failure);
    }
    const calls: string[] = [],
        queries: string[] = [];
    const logs: {
        timestamp: string;
        message: string;
        level: string;
        service?: string;
    }[] = Array.from({ length: 320 }, (_, index) => ({
        timestamp: String(BigInt(Date.now() - index * 60_000) * 1_000_000n),
        message:
            index % 9 === 0
                ? "Synthetic upstream request failed; retry scheduled."
                : `Synthetic application event ${index + 1}: request completed.`,
        level: index % 9 === 0 ? "warning" : "info",
    }));
    const behavior = { unavailable: false, redirect: false, large: false };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (behavior.unavailable)
                return new Response("synthetic private provider failure", {
                    status: 503,
                });
            if (behavior.redirect)
                return Response.redirect("https://untrusted.example", 302);
            if (behavior.large) return new Response("x".repeat(2_000_001));
            if (url.pathname === "/loki/api/v1/query_range") {
                const query = url.searchParams.get("query") ?? "";
                queries.push(query);
                const literal = /\}\s*\|=\s*("(?:[^"\\]|\\.)*")$/.exec(query)?.[1];
                const serviceLiteral = /(?:\{|,)service=("(?:[^"\\]|\\.)*")/.exec(
                    query
                )?.[1];
                const search: unknown = literal ? JSON.parse(literal) : "";
                const service: unknown = serviceLiteral
                    ? JSON.parse(serviceLiteral)
                    : undefined;
                const start = BigInt(url.searchParams.get("start") ?? "0"),
                    end = BigInt(url.searchParams.get("end") ?? "0");
                const selected = logs
                    .filter(
                        (log) =>
                            BigInt(log.timestamp) >= start &&
                            BigInt(log.timestamp) < end &&
                            typeof search === "string" &&
                            log.message.includes(search) &&
                            (service === undefined ||
                                service === (log.service ?? "demo-web"))
                    )
                    .toSorted((left, right) =>
                        right.timestamp.localeCompare(left.timestamp)
                    )
                    .slice(0, Number(url.searchParams.get("limit")));
                return Response.json({
                    status: "success",
                    data: {
                        resultType: "streams",
                        result: ["info", "warning", "error"].map((level) => ({
                            stream: {
                                host: "demo",
                                service:
                                    typeof service === "string" ? service : "demo-web",
                                level,
                            },
                            values: selected
                                .filter((log) => log.level === level)
                                .map((log) => [log.timestamp, log.message]),
                        })),
                    },
                });
            }
            if (url.pathname === "/v1.47/containers/json" && request.method === "GET") {
                const filters = v.parse(
                    v.object({ label: v.array(v.string()) }),
                    JSON.parse(url.searchParams.get("filters") ?? "{}")
                );
                return Response.json(
                    [...containers.values()]
                        .filter((detail) =>
                            filters.label.every((label) => {
                                const separator = label.indexOf("=");
                                return (
                                    separator > 0 &&
                                    detail.Config.Labels?.[label.slice(0, separator)] ===
                                        label.slice(separator + 1)
                                );
                            })
                        )
                        .map((detail) => ({ Id: detail.Id }))
                );
            }
            const match =
                /^\/v1\.47\/containers\/([a-f0-9]{64})\/(json|start|stop|restart)$/.exec(
                    url.pathname
                );
            const detail = match?.[1] ? containers.get(match[1]) : undefined;
            if (!detail) return new Response(null, { status: 404 });
            const readyAt = readiness.get(detail.Id);
            if (readyAt !== undefined && Date.now() >= readyAt) {
                detail.State.Health = {
                    Status: detail.Id === failureId ? "unhealthy" : "healthy",
                };
                readiness.delete(detail.Id);
                logs.unshift({
                    timestamp: String(BigInt(Date.now()) * 1_000_000n),
                    message: `Synthetic health check ${detail.State.Health.Status} for ${detail.Name}.`,
                    level: detail.Id === failureId ? "error" : "info",
                    service: detail.Name.replace(/^\//, ""),
                });
            }
            if (match?.[2] === "json" && request.method === "GET")
                return Response.json({
                    ...detail,
                    Config: {
                        ...detail.Config,
                        Env: ["PRIVATE_KEY=must-never-reach-browser"],
                    },
                });
            if (
                request.method !== "POST" ||
                !["start", "stop", "restart"].includes(match?.[2] ?? "")
            )
                return new Response(null, { status: 405 });
            const operation = match?.[2] ?? "";
            calls.push(
                `${operation}:${detail.Config.Labels?.["com.docker.compose.service"] ?? ""}`
            );
            if (options.actionDelayMs) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        const signal = AbortSignal.any([request.signal, lifetime.signal]);
                        signal.throwIfAborted();
                        const cancel = () => {
                            clearTimeout(timer);
                            reject(new Error("Synthetic action cancelled"));
                        };
                        const timer = setTimeout(() => {
                            signal.removeEventListener("abort", cancel);
                            resolve();
                        }, options.actionDelayMs);
                        signal.addEventListener("abort", cancel, { once: true });
                    });
                } catch {
                    return new Response(null, { status: 503 });
                }
            }
            detail.State.Status = operation === "stop" ? "exited" : "running";
            readiness.delete(detail.Id);
            if (operation !== "stop" && options.healthDelayMs !== undefined) {
                detail.State.Health = { Status: "starting" };
                readiness.set(detail.Id, Date.now() + (options.healthDelayMs ?? 0));
            }
            if (operation === "stop") detail.State.FinishedAt = new Date().toISOString();
            else detail.State.StartedAt = new Date().toISOString();
            logs.unshift({
                timestamp: String(BigInt(Date.now()) * 1_000_000n),
                message: `Synthetic ${operation} completed for ${detail.Name}.`,
                level: "info",
                service: detail.Name.replace(/^\//, ""),
            });
            return new Response(null, { status: 204 });
        },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const target: ApplicationTarget = {
        id: "demo",
        label: "Demo host",
        endpoint: url,
        projects: options.includeFailure ? ["demo", "failure-demo"] : ["demo"],
        logs: { labels: { host: "demo" }, serviceLabel: "service", servicePrefix: "" },
    };
    return {
        target,
        url,
        containers,
        calls,
        logs,
        queries,
        behavior,
        close: () => {
            lifetime.abort();
            return server.stop(true);
        },
    };
}
