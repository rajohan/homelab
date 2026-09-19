import type { DockerDetail, DockerPort } from "./docker";

type Condition = "service_started" | "service_healthy" | "service_completed_successfully";
interface Dependency {
    readonly service: string;
    readonly condition: Condition;
}

function dependencies(item: DockerDetail): readonly Dependency[] {
    return (item.Config.Labels?.["com.docker.compose.depends_on"] ?? "")
        .split(",")
        .filter(Boolean)
        .map((value) => {
            const [service, condition] = value.split(":");
            if (
                !service ||
                ![
                    "service_started",
                    "service_healthy",
                    "service_completed_successfully",
                ].includes(condition ?? "")
            )
                throw new Error("Unsupported application dependency metadata");
            return { service, condition: condition as Condition };
        });
}

function serviceName(item: DockerDetail): string | undefined {
    return item.Config.Labels?.["com.docker.compose.service"];
}

/**
 * Order an existing project and reject incomplete or cyclic dependencies before any writes.
 * @param details - Complete inspected containers from one allowlisted Compose project.
 * @returns Dependency-first order; no container is created or reconfigured.
 */
export function orderApplicationDependencies(
    details: readonly DockerDetail[]
): readonly DockerDetail[] {
    const ordered: DockerDetail[] = [],
        visited = new Set<string>(),
        visiting = new Set<string>();
    const visit = (item: DockerDetail) => {
        if (visited.has(item.Id)) return;
        if (visiting.has(item.Id)) throw new Error("Application dependency cycle");
        visiting.add(item.Id);
        for (const dependency of dependencies(item)) {
            const matches = details.filter(
                (candidate) => serviceName(candidate) === dependency.service
            );
            if (matches.length === 0)
                throw new Error("An application dependency is missing from the project");
            for (const match of matches) visit(match);
        }
        visiting.delete(item.Id);
        visited.add(item.Id);
        ordered.push(item);
    };
    for (const item of details) visit(item);
    return ordered;
}

async function pause(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Application dependency wait was cancelled"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, 500);
        signal.addEventListener("abort", abort, { once: true });
    });
}

/**
 * Honor Compose readiness conditions before starting a dependent existing container.
 * @param item - Container about to start.
 * @param details - Complete selection inspected before the operation.
 * @param port - Worker-owned transport for the same host.
 * @param signal - Overall job cancellation/deadline.
 * @param report - Shared worker progress publisher for readiness waits.
 * @returns Once every declared dependency is ready, or rejects without starting this container.
 */
export async function waitForApplicationDependencies(
    item: DockerDetail,
    details: readonly DockerDetail[],
    port: DockerPort,
    signal: AbortSignal,
    report: (message: string) => Promise<void> = async () => {}
): Promise<void> {
    for (const dependency of dependencies(item)) {
        for (const candidate of details.filter(
            (row) => serviceName(row) === dependency.service
        )) {
            const conditions = {
                service_started: "start",
                service_healthy: "become healthy",
                service_completed_successfully: "complete successfully",
            };
            await report(
                `Waiting for ${candidate.Name.replace(/^\//, "").slice(0, 100)} to ${conditions[dependency.condition]}.`
            );
            for (;;) {
                signal.throwIfAborted();
                const current = await port.inspect(candidate.Id, signal);
                if (
                    dependency.condition === "service_started" &&
                    current.State.Status === "running"
                )
                    break;
                if (
                    dependency.condition === "service_healthy" &&
                    current.State.Health?.Status === "healthy"
                )
                    break;
                if (
                    dependency.condition === "service_completed_successfully" &&
                    current.State.Status === "exited" &&
                    current.State.ExitCode === 0
                )
                    break;
                if (
                    current.State.Health?.Status === "unhealthy" ||
                    ["dead", "exited"].includes(current.State.Status) ||
                    (dependency.condition === "service_healthy" && !current.State.Health)
                )
                    throw new Error("Application dependency did not become ready");
                await pause(signal);
            }
        }
    }
}

/**
 * Wait for a started container's configured health check under the existing job deadline.
 * @param item - Exact container selected before execution.
 * @param port - The same worker-owned Docker transport.
 * @param signal - Cancellation and bounded execution deadline.
 * @param report - Shared job progress publisher; no provider error text is forwarded.
 * @param allowCompleted - Whether this project expects a successful one-shot dependency.
 * @returns Once the container is running and healthy, or has completed as declared.
 */
export async function waitForApplicationReady(
    item: DockerDetail,
    port: DockerPort,
    signal: AbortSignal,
    report: (message: string) => Promise<void>,
    allowCompleted: boolean
): Promise<void> {
    await report(
        `Waiting for ${item.Name.replace(/^\//, "").slice(0, 100)} to ${item.State.Health ? "become healthy" : "reach its ready state"}.`
    );
    for (;;) {
        signal.throwIfAborted();
        const current = await port.inspect(item.Id, signal);
        if (
            current.State.Status === "running" &&
            (!current.State.Health || current.State.Health.Status === "healthy")
        )
            return;
        if (
            allowCompleted &&
            current.State.Status === "exited" &&
            current.State.ExitCode === 0
        )
            return;
        if (
            ["dead", "exited", "paused"].includes(current.State.Status) ||
            current.State.Health?.Status === "unhealthy"
        ) {
            await report(
                `${item.Name.replace(/^\//, "").slice(0, 100)} failed its readiness check.`
            );
            throw new Error("Container did not reach its ready state");
        }
        await pause(signal);
    }
}

/**
 * Identify completed one-shot dependencies that are not expected to stay running.
 * @param item - Container whose final state is checked.
 * @param details - The complete project selection.
 * @returns Whether the project explicitly requires this service to complete successfully.
 */
export function isCompletionDependency(
    item: DockerDetail,
    details: readonly DockerDetail[]
): boolean {
    return details.some((candidate) =>
        dependencies(candidate).some(
            (dependency) =>
                dependency.service === serviceName(item) &&
                dependency.condition === "service_completed_successfully"
        )
    );
}
