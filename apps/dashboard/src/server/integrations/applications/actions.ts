import type {
    ApplicationOperation,
    ApplicationSelection,
} from "@homelab/contracts/applications";

import type { ApplicationTarget } from "./configuration";
import {
    orderApplicationDependencies,
    waitForApplicationDependencies,
    isCompletionDependency,
    waitForApplicationReady,
} from "./dependencies";
import type { DockerDetail, DockerPort } from "./docker";
import { mapDockerApplication } from "./inventory";
import { selectionRevision } from "./selection";

/**
 * Revalidate exact current identities immediately before existing-container lifecycle calls.
 * @param target - Configured host and allowlisted projects.
 * @param port - Worker-only Docker transport.
 * @param intent - The operator's exact saved selection and revision.
 * @param signal - Job cancellation/deadline; ambiguous outcomes are never replayed automatically.
 * @param report - Shared worker progress publisher; messages contain safe container names only.
 * @returns Completion after requested calls and a final state check.
 */
export async function performApplicationAction(
    target: ApplicationTarget,
    port: DockerPort,
    intent: {
        selection: ApplicationSelection;
        revision: string;
        operation: ApplicationOperation;
    },
    signal: AbortSignal,
    report: (message: string) => Promise<void> = async () => {}
): Promise<void> {
    await report("Checking the selected containers and their current state.");
    const ids =
        intent.selection.kind === "container"
            ? [intent.selection.target]
            : await port.list(signal);
    const details: DockerDetail[] = [];
    for (const id of ids) {
        const detail = await port.inspect(id, signal);
        if (
            intent.selection.kind === "container" ||
            detail.Config.Labels?.["com.docker.compose.project"] ===
                intent.selection.target
        )
            details.push(detail);
    }
    if (
        details.length === 0 ||
        details.length > 50 ||
        selectionRevision(
            details.map((detail) => mapDockerApplication(target, detail)),
            intent.selection
        ) !== intent.revision
    )
        throw new Error("Application selection changed before execution");
    const project = intent.selection.kind === "project";
    const ordered = project ? orderApplicationDependencies(details) : details;
    if (
        intent.operation === "stop" ||
        (intent.operation === "restart" && intent.selection.kind === "project")
    ) {
        for (const detail of ordered.toReversed()) {
            signal.throwIfAborted();
            await port.inspect(detail.Id, signal);
            await report(`Stopping ${detail.Name.replace(/^\//, "").slice(0, 100)}.`);
            await port.act(detail.Id, "stop", signal);
        }
    }
    if (intent.operation !== "stop") {
        const operation =
            intent.selection.kind === "project" ? "start" : intent.operation;
        for (const detail of ordered) {
            signal.throwIfAborted();
            if (project)
                await waitForApplicationDependencies(
                    detail,
                    details,
                    port,
                    signal,
                    report
                );
            await port.inspect(detail.Id, signal);
            await report(
                `${operation === "restart" ? "Restarting" : "Starting"} ${detail.Name.replace(/^\//, "").slice(0, 100)}.`
            );
            await port.act(detail.Id, operation, signal);
        }
    }
    for (const detail of ordered) {
        if (intent.operation !== "stop") {
            await waitForApplicationReady(
                detail,
                port,
                signal,
                report,
                project && isCompletionDependency(detail, details)
            );
            continue;
        }
        const current = await port.inspect(detail.Id, signal);
        if (!["exited", "created"].includes(current.State.Status))
            throw new Error("Container has not reached the requested state");
    }
    await report("All selected containers reached the requested state.");
}
