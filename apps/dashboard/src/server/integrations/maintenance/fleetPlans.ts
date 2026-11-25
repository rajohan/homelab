import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import { maintenanceRevision, type MaintenanceTarget } from "./configuration";
import { type MaintenanceObservation, observationSchema } from "./execution";
import { maintenanceHosts } from "./hosts";
import { maintenancePlan, type MaintenanceReading } from "./jobs";
import { discoveredMaintenanceTarget } from "./reportedTarget";

type FleetReport = NonNullable<MaintenanceObservation["fleet"]>;
type Reading = MaintenanceReading & { key: string };

function observed(row: MaintenanceReading | undefined, configuration: string) {
    if (!row || row.value.configuration !== configuration) return null;
    const parsed = v.safeParse(observationSchema, row.value.observation);
    return parsed.success ? parsed.output : null;
}

function localReading(
    target: MaintenanceTarget,
    current: MaintenanceReading | undefined,
    currentObservation: MaintenanceObservation | null | undefined,
    owner: MaintenanceTarget | undefined,
    hostReading: MaintenanceReading | undefined,
    hostObservation: MaintenanceObservation | null | undefined,
    connections: readonly UpdateTarget[]
): {
    reading: MaintenanceReading | null;
    required?: boolean | null;
    canonicalUnit?: string;
} {
    let reading: MaintenanceReading | null = null;
    if (current && currentObservation) {
        // Jobs and confirmation revisions concern one target and never carry the full host report.
        const { fleet: _fleet, ...observation } = currentObservation;
        reading = {
            ...current,
            value: { configuration: current.value.configuration, observation },
        };
    }
    if (target.kind !== "service" || !owner) return { reading };
    const state = reading?.value.observation;
    const fleet = hostObservation?.fleet;
    if (!hostReading?.fresh || !hostObservation || fleet?.evidence !== "measured") {
        if (state && state.active !== "inactive") {
            state.serviceRestartRequired = null;
            state.serviceEvidence =
                hostReading?.fresh && fleet?.evidence === "not-installed"
                    ? "not-installed"
                    : "check-failed";
        }
        return { reading, required: null };
    }

    const unit = state?.canonicalUnit ?? target.service;
    const pending = fleet.services.find(
        (entry) => entry.unit === unit || (unit && entry.aliases?.includes(unit))
    );
    const hostIsNewer =
        !reading?.fresh ||
        !state ||
        Date.parse(hostReading.capturedAt) >= Date.parse(reading.capturedAt);
    if (hostIsNewer && pending?.restartable && pending.invocationId) {
        // The host report itself proves the newer running identity for this configured recipe.
        return {
            required: true,
            reading: {
                ...hostReading,
                value: {
                    configuration: maintenanceRevision(target, connections),
                    observation: {
                        bootId: hostObservation.bootId,
                        active: "active",
                        canonicalUnit: pending.unit,
                        invocationId: pending.invocationId,
                        rebootRequired: hostObservation.rebootRequired,
                        serviceEvidence: "measured",
                        serviceRestartRequired: true,
                        health: false,
                    },
                },
            },
        };
    }
    if (state && reading?.fresh) {
        if (pending) state.canonicalUnit = pending.unit;
        const sameBoot = state.bootId === hostObservation.bootId;
        const currentInstance =
            !pending ||
            (state.active === "active" &&
                (!pending.invocationId || state.invocationId === pending.invocationId));
        if (!sameBoot || !currentInstance) {
            state.invocationId = null;
            state.serviceRestartRequired = null;
            state.serviceEvidence = "check-failed";
            return { reading, required: null };
        }
        state.serviceEvidence = state.active === "inactive" ? "stopped" : "measured";
        state.serviceRestartRequired = Boolean(pending);
    }
    return {
        reading,
        required: Boolean(pending),
        ...(pending ? { canonicalUnit: pending.unit } : {}),
    };
}

/**
 * Join reviewed recipes with the complete current host reports. Discovery can only grant a
 * service action on an opted-in host, for the live identity reported by that host.
 * @param client - Product reader or transaction validating an admission.
 * @param targets - Deployment-owned maintenance recipes.
 * @param connections - Deployment-owned update connections.
 * @returns Public rows in `plan` paired with private admission inputs and their job key.
 */
export async function fleetMaintenancePlans(
    client: SQL | TransactionSQL,
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[]
) {
    const readings = await client<
        Reading[]
    >`SELECT key,value,captured_at::text AS "capturedAt",
        captured_at > now()-interval '2 minutes' AS fresh
        FROM operation_snapshots WHERE key LIKE 'maintenance:%'`;
    const byKey = new Map(
        readings.map((row) => [row.key.slice("maintenance:".length), row])
    );
    const hosts = maintenanceHosts(targets, connections);
    const sources = new Map(
        connections.map((connection) => [connection.id, connection.source])
    );
    const owners = new Map(
        targets.filter((t) => t.kind === "host").map((t) => [hosts.get(t.id)!.id, t])
    );
    const samples = new Map(
        targets.map((t) => [
            t.id,
            observed(byKey.get(t.id), maintenanceRevision(t, connections)),
        ])
    );
    const known = new Set(
        targets
            .filter((t) => t.service)
            .flatMap((t) =>
                [t.service, samples.get(t.id)?.canonicalUnit]
                    .filter(Boolean)
                    .map((unit) => JSON.stringify([hosts.get(t.id)!.id, unit]))
            )
    );
    const make = async (
        target: MaintenanceTarget,
        reading: MaintenanceReading | null,
        host: { id: string; label: string },
        inspectTarget: string,
        fleetEvidence: FleetReport["evidence"] | null,
        reportedRequired?: boolean | null,
        restartable = true,
        canonicalUnit?: string
    ) => {
        const { configuration, observation, ...publicPlan } = await maintenancePlan(
            client,
            target,
            connections,
            reading
        );
        const discovered = Boolean(target.reportedOn);
        const allowed = publicPlan.allowed && restartable;
        const required =
            target.kind === "host"
                ? observation?.rebootRequired
                : observation?.serviceRestartRequired;
        const external =
            publicPlan.external || (discovered && !restartable && Boolean(observation));
        return {
            target,
            configuration,
            observation,
            action: discovered
                ? `maintenance.reported.${inspectTarget}`
                : `maintenance.restart.${target.id}`,
            plan: {
                ...publicPlan,
                host,
                source: sources.get(target.connection)!,
                inspectTarget,
                fleetEvidence,
                discovered,
                unit:
                    canonicalUnit ?? observation?.canonicalUnit ?? target.service ?? null,
                allowed,
                external,
                reason:
                    !restartable && discovered && observation && !publicPlan.external
                        ? "Linux reports this service, but cannot confirm a restartable running instance."
                        : publicPlan.reason,
                serviceEvidence: observation?.serviceEvidence ?? null,
                observed: Boolean(observation),
                active: observation?.active ?? null,
                required:
                    reportedRequired === undefined
                        ? (required ?? null)
                        : reportedRequired,
            },
        };
    };
    const rows: Awaited<ReturnType<typeof make>>[] = [];
    for (const target of targets) {
        const host = hosts.get(target.id)!;
        const owner = owners.get(host.id);
        const hostReading = owner ? byKey.get(owner.id) : undefined;
        const full = owner ? samples.get(owner.id) : null;
        const fleet = full?.fleet;
        const current = byKey.get(target.id);
        const { reading, required, canonicalUnit } = localReading(
            target,
            current,
            samples.get(target.id),
            owner,
            hostReading,
            full,
            connections
        );
        rows.push(
            await make(
                target,
                reading,
                host,
                owner?.id ?? target.id,
                target.kind === "host" && hostReading?.fresh
                    ? (fleet?.evidence ?? null)
                    : null,
                required,
                true,
                canonicalUnit
            )
        );
        if (target !== owner || !hostReading || !full || fleet?.evidence !== "measured")
            continue;
        for (const entry of fleet.services) {
            if (
                [entry.unit, ...(entry.aliases ?? [])].some((unit) =>
                    known.has(JSON.stringify([host.id, unit]))
                )
            )
                continue;
            const recipe = discoveredMaintenanceTarget(target, entry.unit);
            const observation: MaintenanceObservation = {
                bootId: full.bootId,
                active: entry.restartable ? "active" : null,
                invocationId: entry.invocationId,
                rebootRequired: full.rebootRequired,
                serviceEvidence: "measured",
                serviceRestartRequired: true,
                health: false,
            };
            rows.push(
                await make(
                    recipe,
                    {
                        ...hostReading,
                        value: {
                            configuration: maintenanceRevision(recipe, connections),
                            observation,
                        },
                    },
                    host,
                    target.id,
                    null,
                    hostReading.fresh ? true : undefined,
                    entry.restartable
                )
            );
        }
    }
    return rows;
}
