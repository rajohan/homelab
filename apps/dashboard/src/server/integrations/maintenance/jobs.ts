import { maintenanceRequestSchema } from "@homelab/contracts/maintenance";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { updateResourceKeys, type UpdateTarget } from "../updates/configuration";
import {
    recordRestartObservation,
    restartObservationTime,
} from "../updates/restartObservation";
import { maintenanceRevision, type MaintenanceTarget } from "./configuration";
import {
    type MaintenanceObservation,
    type MaintenanceProbe,
    MaintenanceRefused,
    observationSchema,
    probeMaintenance,
} from "./execution";
import { maintenanceHosts } from "./hosts";
import { discoveredMaintenanceTarget, requiresNewSshConnection } from "./reportedTarget";

const payloadSchema = v.strictObject({
    target: maintenanceRequestSchema.entries.target,
    configuration: maintenanceRequestSchema.entries.revision,
    revision: maintenanceRequestSchema.entries.revision,
    expected: observationSchema,
    unit: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
    requiredOnly: v.optional(v.boolean()),
});

export interface MaintenanceReading {
    value: {
        configuration: string;
        observation: MaintenanceObservation | null;
        lastMeasured?: { observation: MaintenanceObservation; capturedAt: string } | null;
    };
    capturedAt: string;
    fresh: boolean;
}

async function saveReading(
    transaction: TransactionSQL,
    id: string,
    configuration: string,
    observation: MaintenanceObservation | null,
    host: boolean
) {
    // Archive only the last measured fleet for display. Its timestamp never authorizes a restart.
    const preserve = host && observation?.fleet?.evidence !== "measured";
    await transaction`INSERT INTO operation_snapshots AS prior (key, value, captured_at)
        VALUES (${`maintenance:${id}`}, ${JSON.stringify({ configuration, observation })}::text::jsonb, clock_timestamp())
        ON CONFLICT (key) DO UPDATE SET captured_at = excluded.captured_at,
        value = excluded.value || CASE WHEN ${preserve} AND prior.value->>'configuration'=excluded.value->>'configuration'
            AND (excluded.value#>>'{observation,bootId}' IS NULL OR excluded.value#>>'{observation,bootId}'=
                coalesce(prior.value#>>'{observation,bootId}',prior.value#>>'{lastMeasured,observation,bootId}'))
            THEN jsonb_build_object('lastMeasured', CASE
                WHEN prior.value#>>'{observation,fleet,evidence}'='measured'
                THEN jsonb_build_object('observation',prior.value->'observation','capturedAt',prior.captured_at)
                ELSE prior.value->'lastMeasured' END)
            ELSE '{}'::jsonb END`;
}

/**
 * Read one recent successful observation, bound to the current restart authority.
 * @param client - Dashboard database or queue-admission transaction.
 * @param target - Reviewed restart target.
 * @param connections - All scoped update connections needed by the recipe and its peer locks.
 * @param reading - Optional observation from the fleet read, including an explicit missing result.
 * @returns A safe confirmation plan and private execution evidence, or an unavailable plan.
 */
export async function maintenancePlan(
    client: SQL | TransactionSQL,
    target: MaintenanceTarget,
    connections: readonly UpdateTarget[],
    reading?: MaintenanceReading | null
) {
    const [row] =
        reading === undefined
            ? await client<
                  MaintenanceReading[]
              >`SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '2 minutes' AS fresh FROM operation_snapshots WHERE key = ${`maintenance:${target.id}`}`
            : [reading];
    const configuration = maintenanceRevision(target, connections);
    const parsed = v.safeParse(observationSchema, row?.value.observation);
    const observation =
        row?.fresh && row.value.configuration === configuration && parsed.success
            ? parsed.output
            : null;
    const revision = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ configuration, observation }))
        .digest("hex");
    const allowed = Boolean(
        (target.workerIndependent || target.proxmox || target.physicalNode) &&
        row?.fresh &&
        observation &&
        (target.kind === "host" ||
            (observation.active === "active" && observation.invocationId !== null))
    );
    const unavailableReason = allowed
        ? null
        : "Refresh the restart status. A stopped or unavailable service cannot be restarted here.";
    return {
        target: target.id,
        label: target.label,
        impact: target.impact,
        kind: target.kind,
        revision,
        configuration,
        observation,
        capturedAt: row?.capturedAt ?? null,
        allowed,
        proxmox: Boolean(target.proxmox || target.physicalNode),
        external: !target.workerIndependent && !target.proxmox && !target.physicalNode,
        reason:
            target.workerIndependent || target.proxmox || target.physicalNode
                ? unavailableReason
                : target.externalReason!,
    };
}

async function wait(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const done = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(done, 2000);
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new Error("Maintenance verification cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

/**
 * Register read-only status jobs and separate, human-confirmed restart jobs.
 * @param targets - Explicitly qualified worker-independent restart recipes.
 * @param connections - Existing SSH authorities; no new trust or credentials are inferred.
 * @param probe - Fixed remote boundary, replaced by synthetic tests.
 * @returns Jobs sharing update host leases; mutation jobs never retry or run on a schedule.
 */
export function maintenanceJobs(
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[],
    probe: MaintenanceProbe = probeMaintenance
): JobHandler[] {
    const hosts = maintenanceHosts(targets, connections);
    const inspectedHosts = new Set(
        targets
            .filter((target) => target.kind === "host")
            .map((target) => hosts.get(target.id)!.id)
    );
    return targets.flatMap((target): JobHandler[] => {
        const hostId = hosts.get(target.id)!.id;
        const owner = targets.find(
            (candidate) =>
                candidate.kind === "host" && candidate.connection === target.connection
        );
        const connection = connections.find((entry) => entry.id === target.connection)!;
        const configuration = maintenanceRevision(target, connections);
        const inspect: JobHandler = {
            definition: {
                key: `maintenance.inspect.${target.id}`,
                label: `Check restart status: ${target.label}`,
                description:
                    "Read restart requirements and service state without changing the host.",
                resourceClass: "network",
                capability: "updates:refresh",
                resourceKeys: [
                    `snapshot:maintenance:${target.id}`,
                    ...updateResourceKeys(connection),
                ],
                timeoutMs: 45_000,
                attemptLimit: 1,
                retrySafe: true,
                intervalSeconds: 60,
                validate: (input) => v.parse(v.strictObject({}), input),
            },
            execute: async (_payload, context) => {
                await context.reportProgress(
                    "Checking the configured service and restart requirements."
                );
                let observation: MaintenanceObservation | null = null;
                try {
                    observation = await probe(
                        connection,
                        target,
                        target.kind === "service" && inspectedHosts.has(hostId)
                            ? "state"
                            : "inspect",
                        context.signal
                    );
                } catch {
                    context.signal.throwIfAborted();
                }
                if (
                    !(await context.commit(async (transaction) => {
                        await saveReading(
                            transaction,
                            target.id,
                            configuration,
                            observation,
                            target.kind === "host"
                        );
                    }))
                )
                    throw new Error("Maintenance status ownership changed");
                if (!observation) throw new Error("Maintenance status is unavailable");
            },
        };
        const configuredServices = new Set(
            targets
                .filter((entry) => hosts.get(entry.id)!.id === hostId)
                .map((entry) => entry.service)
        );
        const restart = (reported: boolean): JobHandler => ({
            definition: {
                key: reported
                    ? `maintenance.reported.${target.id}`
                    : `maintenance.restart.${target.id}`,
                label: reported
                    ? `Restart a reported service on ${target.label}`
                    : `Restart ${target.label}`,
                description: target.impact,
                resourceClass: "interactive",
                capability: "maintenance:restart",
                resourceKeys: [
                    ...new Set(
                        [
                            connection,
                            ...connections.filter((entry) =>
                                target.lockConnections?.includes(entry.id)
                            ),
                        ].flatMap((entry) => updateResourceKeys(entry))
                    ),
                ],
                timeoutMs: target.kind === "host" ? 600_000 : 360_000,
                attemptLimit: 1,
                retrySafe: false,
                intervalSeconds: null,
                admission: "integration",
                validate: (input) => v.parse(payloadSchema, input),
            },
            execute: async (value, context) => {
                const input = v.parse(payloadSchema, value);
                if (
                    reported !== Boolean(input.unit) ||
                    (input.unit && configuredServices.has(input.unit))
                )
                    throw new Error(
                        "This service requires its configured restart recipe."
                    );
                const recipe = reported
                    ? discoveredMaintenanceTarget(target, input.unit!)
                    : target;
                // Every service's final reading refreshes the owner's whole fleet.
                const probeRecipe = owner?.systemBusProfile
                    ? { ...recipe, systemBusProfile: owner.systemBusProfile }
                    : recipe;
                const refuse = async (reason: string): Promise<never> => {
                    const result = {
                        label: recipe.label,
                        operation: "restart-not-started",
                        installed: null,
                        health: "not-checked",
                        rebootRequired: null,
                        warnings: [reason],
                    };
                    await context.commit(async (transaction) => {
                        await transaction`UPDATE job_runs SET results=${JSON.stringify([result])}::text::jsonb WHERE id=${context.runId}`;
                    });
                    throw new MaintenanceRefused(reason);
                };
                const requiredOnly = Boolean(input.requiredOnly || reported);
                if (!recipe.workerIndependent)
                    return refuse("This target requires an external restart.");
                if (
                    input.target !== recipe.id ||
                    input.configuration !== maintenanceRevision(recipe, connections)
                )
                    return refuse(
                        "The restart configuration changed after confirmation."
                    );
                const authorize = async () => {
                    let fresh = false;
                    if (
                        !(await context.commit(async (transaction) => {
                            const [request] = await transaction<
                                { fresh: boolean }[]
                            >`SELECT created_at >= clock_timestamp() - interval '5 minutes' AS fresh FROM job_runs WHERE id = ${context.runId}`;
                            fresh = Boolean(request?.fresh);
                        }))
                    )
                        throw new Error("Restart ownership changed");
                    if (!fresh)
                        await refuse("The restart confirmation expired in the queue.");
                };
                await authorize();
                // The mutation probes Linux's current service requirement immediately before try-restart.
                const before = await probe(
                    connection,
                    recipe,
                    recipe.kind === "service" ? "state" : "inspect",
                    context.signal
                ).catch(() =>
                    refuse(
                        "The host could not confirm the service identity before restart."
                    )
                );
                if (
                    before.bootId !== input.expected.bootId ||
                    before.active !== input.expected.active ||
                    before.invocationId !== input.expected.invocationId ||
                    (recipe.kind === "service" && before.invocationId === null)
                )
                    return refuse(
                        "The host or service identity changed after confirmation."
                    );
                context.signal.throwIfAborted();
                await authorize();
                if (requiredOnly && recipe.kind === "host" && !before.rebootRequired)
                    return refuse("The host no longer reports a restart requirement.");
                if (recipe.preflight) {
                    await context.reportProgress("Checking restart prerequisites.");
                    await probe(connection, recipe, "preflight", context.signal).catch(
                        () => refuse("The host's restart prerequisites were not met.")
                    );
                    await authorize();
                }
                await context.reportProgress(
                    recipe.kind === "host"
                        ? "Requesting the confirmed host restart. This request cannot be undone once accepted."
                        : "Restarting the confirmed service."
                );
                let after: MaintenanceObservation | undefined;
                try {
                    after = await probe(
                        connection,
                        probeRecipe,
                        "restart",
                        context.signal,
                        input.expected,
                        requiredOnly,
                        context.runId
                    );
                } catch (error) {
                    if (error instanceof MaintenanceRefused) return refuse(error.message);
                    context.signal.throwIfAborted();
                }
                let needsClearReport =
                    requiredOnly ||
                    input.expected.serviceRestartRequired === true ||
                    recipe.service === "systemd-manager";
                const recovered = (current: MaintenanceObservation) => {
                    if (recipe.kind === "host")
                        return current.health && current.bootId !== before.bootId;
                    // Once Linux flags this service, only a measured clear report can release the batch.
                    needsClearReport ||= current.serviceRestartRequired === true;
                    return (
                        current.health &&
                        current.bootId === before.bootId &&
                        current.active === "active" &&
                        Boolean(current.invocationId) &&
                        (recipe.service === "systemd-manager" ||
                            current.invocationId !== before.invocationId) &&
                        (!needsClearReport || current.serviceRestartRequired === false)
                    );
                };
                if (
                    !after ||
                    !recovered(after) ||
                    requiresNewSshConnection(recipe.service)
                ) {
                    await context.reportProgress(
                        recipe.kind === "service" && needsClearReport
                            ? "Checking service health and waiting for Linux to clear the restart requirement."
                            : "Verifying recovery through a fresh host connection."
                    );
                    after = undefined;
                    const serviceTimeout = recipe.systemBusProfile ? 200_000 : 80_000;
                    const until =
                        Date.now() + (recipe.kind === "host" ? 520_000 : serviceTimeout);
                    while (!after && Date.now() < until) {
                        await wait(context.signal);
                        try {
                            const current = await probe(
                                connection,
                                probeRecipe,
                                "verify",
                                AbortSignal.any([
                                    context.signal,
                                    AbortSignal.timeout(40_000),
                                ]),
                                input.expected,
                                false,
                                context.runId
                            );
                            if (recovered(current)) after = current;
                        } catch (error) {
                            if (error instanceof MaintenanceRefused)
                                return refuse(error.message);
                            context.signal.throwIfAborted();
                        }
                    }
                }
                if (!after?.health)
                    throw new Error(
                        recipe.kind === "service" && needsClearReport
                            ? "The service did not pass both its health check and a fresh restart requirement check in time."
                            : "Restart health verification failed"
                    );
                const { fleet, ...verified } = after;
                const result = {
                    label: recipe.label,
                    operation:
                        recipe.kind === "host" ? "host-restart" : "service-restart",
                    installed: null,
                    health: "passed",
                    rebootRequired: after.rebootRequired,
                    warnings: [],
                };
                if (
                    !(await context.commit(async (transaction) => {
                        await transaction`UPDATE job_runs SET results = ${JSON.stringify([result])}::text::jsonb WHERE id = ${context.runId}`;
                        await recordRestartObservation(
                            transaction,
                            connection.source,
                            connections.some(
                                (other) =>
                                    other.source === connection.source &&
                                    other.host.toLowerCase() !==
                                        connection.host.toLowerCase()
                            )
                                ? null
                                : after.rebootRequired,
                            await restartObservationTime(transaction)
                        );
                        // The final health check already collected a new report under this host's lease.
                        // Preserve it for the next service instead of waiting for a scheduled inspection.
                        if (!reported)
                            await saveReading(
                                transaction,
                                target.id,
                                configuration,
                                {
                                    ...verified,
                                    health: false,
                                    ...(target.kind === "host" && fleet ? { fleet } : {}),
                                },
                                target.kind === "host"
                            );
                        if (recipe.kind === "service" && owner) {
                            await saveReading(
                                transaction,
                                owner.id,
                                maintenanceRevision(owner, connections),
                                fleet
                                    ? {
                                          bootId: verified.bootId,
                                          rebootRequired: verified.rebootRequired,
                                          fleet,
                                          active: null,
                                          invocationId: null,
                                          serviceRestartRequired: null,
                                          serviceEvidence: null,
                                          health: false,
                                      }
                                    : null,
                                true
                            );
                        }
                    }))
                )
                    throw new Error("Restart result ownership changed");
                await context.reportProgress("Restart completed and health verified.");
            },
        });
        const handlers = [inspect];
        if (target.workerIndependent) handlers.push(restart(false));
        if (target.kind === "host" && target.restartReportedServices)
            handlers.push(restart(true));
        return handlers;
    });
}
