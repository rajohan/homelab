import type {
    ApplicationOperation,
    ApplicationSelection,
} from "@homelab/contracts/applications";

import type { ApplicationTarget } from "./configuration";
import {
    orderApplicationDependencies,
    waitForApplicationDependencies,
    isCompletionDependency,
    isApplicationReady,
    waitForApplicationReady,
    verifyNamespaceProviders,
} from "./dependencies";
import type { DockerDetail, DockerPort } from "./docker";
import { mapDockerApplication } from "./inventory";
import { selectionRevision, selectApplications } from "./selection";

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
    const ids = await port.list(
        signal,
        intent.selection.kind === "project" ? intent.selection.target : undefined
    );
    if (ids.length === 0 || ids.length > 200)
        throw new Error("Application selection changed before execution");
    const inspected: DockerDetail[] = [];
    for (const id of ids) {
        const detail = await port.inspect(id, signal);
        if (
            intent.selection.kind === "container" ||
            detail.Config.Labels?.["com.docker.compose.project"] ===
                intent.selection.target
        )
            inspected.push(detail);
    }
    const applications = inspected.map((detail) => mapDockerApplication(target, detail));
    const scoped = selectApplications(
        {
            capturedAt: new Date().toISOString(),
            hosts: [
                { id: target.id, label: target.label, available: true, applications },
            ],
        },
        target.id,
        intent.selection,
        true
    );
    const scopeIds = new Set(scoped.map((item) => item.containerId));
    const details = inspected.filter((detail) => scopeIds.has(detail.Id));
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
    const coordinated = project || details.length > 1;
    const ordered = coordinated
        ? orderApplicationDependencies(details, inspected)
        : details;
    const mutated = new Set<string>();
    const revalidateMembership = async () => {
        const currentIds = await port.list(
            signal,
            intent.selection.kind === "project" ? intent.selection.target : undefined
        );
        if (
            currentIds.length !== ids.length ||
            currentIds.some((id) => !ids.includes(id))
        )
            throw new Error("Application project membership changed before execution");
    };
    if (intent.operation !== "stop") {
        try {
            await verifyNamespaceProviders(details, port, signal);
        } catch (error) {
            await report(
                "A shared namespace dependency is unavailable. No containers were changed; recreate the affected services before retrying."
            );
            throw error;
        }
    }
    const revalidate = async (detail: DockerDetail) => {
        signal.throwIfAborted();
        const current = await port.inspect(detail.Id, signal);
        if (
            !mutated.has(detail.Id) &&
            mapDockerApplication(target, current).revision !==
                mapDockerApplication(target, detail).revision
        )
            throw new Error("Application selection changed before execution");
        await revalidateMembership();
    };
    if (intent.operation === "stop" || (intent.operation === "restart" && coordinated)) {
        for (const detail of ordered.toReversed()) {
            if (
                !project &&
                detail.Id !== intent.selection.target &&
                ["created", "exited"].includes(detail.State.Status)
            )
                continue;
            signal.throwIfAborted();
            await report(`Stopping ${detail.Name.replace(/^\//, "").slice(0, 100)}.`);
            await revalidate(detail);
            await port.act(detail.Id, "stop", signal);
            mutated.add(detail.Id);
        }
    }
    if (intent.operation !== "stop") {
        const operation = coordinated ? "start" : intent.operation;
        for (const detail of ordered) {
            if (
                !project &&
                intent.operation === "restart" &&
                detail.Id !== intent.selection.target &&
                ["created", "exited"].includes(detail.State.Status)
            )
                continue;
            signal.throwIfAborted();
            await waitForApplicationDependencies(detail, inspected, port, signal, report);
            await report(
                `${operation === "restart" ? "Restarting" : "Starting"} ${detail.Name.replace(/^\//, "").slice(0, 100)}.`
            );
            await revalidate(detail);
            await port.act(detail.Id, operation, signal);
            mutated.add(detail.Id);
        }
    }
    if (intent.operation !== "stop")
        for (const detail of ordered) {
            if (
                !project &&
                intent.operation === "restart" &&
                detail.Id !== intent.selection.target &&
                ["created", "exited"].includes(detail.State.Status)
            )
                continue;
            await waitForApplicationReady(
                detail,
                port,
                signal,
                report,
                project && isCompletionDependency(detail, details)
            );
        }
    await revalidateMembership();
    // Read every selected container again after all readiness waits. Earlier
    // readiness observations can be invalidated while a later service initializes.
    for (let offset = 0; offset < ordered.length; offset += 4) {
        signal.throwIfAborted();
        const ready = await Promise.all(
            ordered.slice(offset, offset + 4).map(async (detail) => {
                const current = await port.inspect(detail.Id, signal);
                if (
                    !project &&
                    intent.operation === "restart" &&
                    detail.Id !== intent.selection.target &&
                    ["created", "exited"].includes(detail.State.Status)
                )
                    return ["created", "exited"].includes(current.State.Status);
                return intent.operation === "stop"
                    ? ["exited", "created"].includes(current.State.Status)
                    : isApplicationReady(
                          current,
                          project && isCompletionDependency(detail, details)
                      );
            })
        );
        if (ready.some((value) => !value))
            throw new Error("A selected container no longer meets the requested state");
    }
    await report("All selected containers reached the requested state.");
}
