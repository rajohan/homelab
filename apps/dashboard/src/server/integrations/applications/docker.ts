import type { ApplicationOperation } from "@homelab/contracts/applications";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";
import type { ApplicationTarget } from "./configuration";

const id = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const text = v.pipe(v.string(), v.maxLength(2000));
const labels = v.record(v.string(), v.string());
const commandVector = v.pipe(v.array(text), v.maxLength(128));
const environmentEntry = v.pipe(v.string(), v.maxLength(16_384));
const environmentVector = v.pipe(v.array(environmentEntry), v.maxLength(512));
const networkText = v.pipe(v.string(), v.maxLength(256));
const portBindings = v.nullable(
    v.pipe(
        v.array(v.object({ HostIp: networkText, HostPort: networkText })),
        v.maxLength(8)
    )
);
const detailSchema = v.object({
    Id: id,
    Name: text,
    Image: text,
    Config: v.object({
        Image: text,
        Labels: v.nullable(labels),
        Entrypoint: v.optional(v.nullable(v.pipe(v.array(text), v.maxLength(128)))),
        Cmd: v.optional(v.nullable(v.pipe(v.array(text), v.maxLength(128)))),
        WorkingDir: v.optional(text),
        Env: v.optional(v.nullable(environmentVector)),
        Healthcheck: v.optional(
            v.nullable(
                v.object({
                    Test: v.optional(commandVector),
                })
            )
        ),
    }),
    HostConfig: v.object({
        NetworkMode: networkText,
        PidMode: v.optional(networkText, ""),
        IpcMode: v.optional(networkText, ""),
    }),
    State: v.object({
        Status: text,
        StartedAt: text,
        FinishedAt: text,
        ExitCode: v.number(),
        Health: v.optional(v.object({ Status: text })),
    }),
    NetworkSettings: v.object({
        Ports: v.nullable(v.pipe(v.record(networkText, portBindings), v.maxEntries(128))),
        Networks: v.pipe(v.record(networkText, v.unknown()), v.maxEntries(32)),
    }),
    Mounts: v.pipe(
        v.array(
            v.object({ Type: text, Source: text, Destination: text, RW: v.boolean() })
        ),
        v.maxLength(64)
    ),
});
export type DockerDetail = v.InferOutput<typeof detailSchema>;
export interface DockerPort {
    /** Limit discovery to one allowlisted project when supplied; otherwise list the configured host inventory. */
    readonly list: (signal: AbortSignal, project?: string) => Promise<readonly string[]>;
    readonly inspect: (container: string, signal: AbortSignal) => Promise<DockerDetail>;
    readonly act: (
        container: string,
        operation: ApplicationOperation,
        signal: AbortSignal
    ) => Promise<void>;
}

/**
 * Create a worker-only Docker transport with fixed endpoints and explicit project discovery.
 * @param target - Validated endpoint and secret reference configuration.
 * @param environment - Worker environment; the web process must not receive these TLS keys.
 * @returns Bounded Docker reads and existing-container start/stop/restart operations only.
 */
export function createDockerPort(
    target: ApplicationTarget,
    environment: Readonly<Record<string, string | undefined>>
): DockerPort {
    const tls = target.tls
        ? {
              ca: environment[target.tls.ca],
              cert: environment[target.tls.certificate],
              key: environment[target.tls.key],
              rejectUnauthorized: true,
          }
        : undefined;
    if (target.tls && (!tls?.ca || !tls.cert || !tls.key))
        throw new Error("Docker client credentials are unavailable");
    const request = (path: string, signal: AbortSignal, method = "GET") =>
        fetch(new URL(`/v1.47${path}`, target.endpoint), {
            method,
            signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(method === "GET" ? 10_000 : 40_000),
            ]),
            redirect: "error",
            ...(tls ? { tls } : {}),
        });
    return {
        async list(signal, selectedProject) {
            if (
                selectedProject !== undefined &&
                !target.projects.includes(selectedProject)
            )
                throw new Error("Project is outside the managed inventory");
            const result: string[] = [];
            for (const project of selectedProject === undefined
                ? target.projects
                : [selectedProject]) {
                const query = new URLSearchParams({
                    all: "true",
                    filters: JSON.stringify({
                        label: [`com.docker.compose.project=${project}`],
                    }),
                });
                const rows = v.parse(
                    v.pipe(v.array(v.object({ Id: id })), v.maxLength(200)),
                    await readBoundedJson(
                        await request(`/containers/json?${query.toString()}`, signal)
                    )
                );
                result.push(...rows.map((row) => row.Id));
                if (result.length > 200)
                    throw new Error("Application inventory exceeds its budget");
            }
            return [...new Set(result)];
        },
        async inspect(container, signal) {
            v.parse(id, container);
            const detail = v.parse(
                detailSchema,
                await readBoundedJson(
                    await request(`/containers/${container}/json`, signal),
                    512 * 1024
                )
            );
            if (
                detail.Id !== container ||
                !target.projects.includes(
                    detail.Config.Labels?.["com.docker.compose.project"] ?? ""
                )
            )
                throw new Error("Container is outside the managed inventory");
            return detail;
        },
        async act(container, operation, signal) {
            v.parse(id, container);
            v.parse(v.picklist(["start", "stop", "restart"]), operation);
            const response = await request(
                `/containers/${container}/${operation}${operation === "start" ? "" : "?t=30"}`,
                signal,
                "POST"
            );
            await response.body?.cancel();
            if (
                response.status !== 204 &&
                !(operation !== "restart" && response.status === 304)
            )
                throw new Error(
                    "Container operation failed; verify its current state before retrying"
                );
        },
    };
}
