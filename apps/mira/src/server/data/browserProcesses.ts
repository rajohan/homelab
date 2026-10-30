import { randomUUID } from "node:crypto";

import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { closeMiraBrowserAccess, requireMiraBrowserAccess } from "./browserAccess";
import { MiraFailure, type MiraContext } from "./context";

const uuid = v.pipe(v.string(), v.uuid());
const containerId = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const authority = v.strictObject({ id: uuid, hostId: uuid, leaseToken: uuid });
type Authority = v.InferOutput<typeof authority>;
interface ProcessRow extends Authority {
    accessId: string;
    imageId: string;
    networkId: string | null;
    phase: "reserved" | "creating" | "created" | "rejected";
    state: "active" | "cleanup" | "removed";
    containerId: string | null;
    leaseExpiresAt: Date;
    current: boolean;
    owner: string;
    runId: string;
    runLease: string;
    hostToken: string;
}
function failure() {
    return new MiraFailure(
        "PRECONDITION_FAILED",
        "Browser process ownership or cleanup evidence is no longer valid."
    );
}
function result(row: ProcessRow) {
    return {
        id: row.id,
        accessId: row.accessId,
        hostId: row.hostId,
        imageId: row.imageId,
        networkId: row.networkId,
        claim: { id: row.id, hostId: row.hostId, leaseToken: row.leaseToken },
        leaseExpiresAt: row.leaseExpiresAt.toISOString(),
        phase: row.phase,
        state: row.state,
        containerId: row.containerId,
        containerName: `mira-browser-${row.id}`,
    };
}
async function capacity(query: TransactionSQL) {
    // Only reservations increase usage; cleanup can only decrease it.
    // Never hold this global lock during another owner's heartbeat or recovery.
    await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:browser:capacity',0))`;
}
async function read(query: TransactionSQL, id: string) {
    const [row] = await query<ProcessRow[]>`
        SELECT p.id,p.access_id AS "accessId",p.host_id AS "hostId",p.image_id AS "imageId",p.network_id AS "networkId",
            p.lease_token AS "leaseToken",p.lease_expires_at AS "leaseExpiresAt",p.phase,p.state,p.container_id AS "containerId",
            p.lease_expires_at>clock_timestamp() AS current,g.owner,g.run_id AS "runId",g.run_lease AS "runLease",g.host_token AS "hostToken"
        FROM mira_browser_processes p JOIN mira_browser_access g ON g.id=p.access_id WHERE p.id=${id}`;
    return row;
}
function context(
    client: SQL,
    transaction: TransactionSQL,
    row: Pick<ProcessRow, "owner" | "runId" | "runLease">
): MiraContext {
    return {
        client,
        transaction,
        owner: row.owner,
        actor: "browser:host",
        run: { id: row.runId, leaseToken: row.runLease },
    };
}
async function lockOwner(query: TransactionSQL, owner: string) {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
}
async function owned<T>(
    client: SQL,
    input: unknown,
    work: (query: TransactionSQL, row: ProcessRow) => Promise<T>
) {
    const claim = v.parse(authority, input);
    return client.begin(async (query) => {
        const initial = await read(query, claim.id);
        if (
            !initial ||
            initial.hostId !== claim.hostId ||
            initial.leaseToken !== claim.leaseToken
        )
            throw failure();
        await lockOwner(query, initial.owner);
        // Recovery may have replaced the controller while this transaction waited.
        const row = (await read(query, claim.id))!;
        if (row.hostId !== claim.hostId || row.leaseToken !== claim.leaseToken)
            throw failure();
        return work(query, row);
    });
}
async function active(client: SQL, query: TransactionSQL, row: ProcessRow) {
    if (row.state !== "active" || !row.current) throw failure();
    await requireMiraBrowserAccess(context(client, query, row), {
        id: row.accessId,
        hostToken: row.hostToken,
        mode: "view",
    });
}
async function stopGrant(query: TransactionSQL, accessId: string) {
    await query`UPDATE mira_browser_consoles SET frame=NULL,frame_at=NULL,payload=NULL,state='idle',method=NULL,expires_at=NULL WHERE access_id=${accessId}`;
    await query`UPDATE mira_browser_access SET state='stopping',policy=NULL WHERE id=${accessId} AND state='active'`;
}

/**
 * Reserve one of two global process slots before any Docker mutation is issued.
 * @param client - Trusted host database connection, never a model-facing endpoint.
 * @param input - Private claimed grant token, persistent host identity and installed immutable image ID.
 * @param transaction - Optional trusted startup transaction already holding the global capacity lock before claiming the human grant.
 * @returns A durable random container identity and private fifteen-second controller lease.
 */
export async function reserveMiraBrowserProcess(
    client: SQL,
    input: unknown,
    transaction?: TransactionSQL
) {
    const request = v.parse(
        v.strictObject({
            accessId: uuid,
            hostToken: uuid,
            hostId: uuid,
            imageId: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
            networkIds: v.optional(
                v.pipe(
                    v.array(containerId),
                    v.minLength(1),
                    v.maxLength(2),
                    v.check((values) => new Set(values).size === values.length)
                )
            ),
        }),
        input
    );
    const reserve = async (query: TransactionSQL) => {
        await capacity(query);
        const [grant] = await query<{ owner: string; runId: string; runLease: string }[]>`
            SELECT owner,run_id AS "runId",run_lease AS "runLease" FROM mira_browser_access WHERE id=${request.accessId} AND host_token=${request.hostToken}`;
        if (!grant) throw failure();
        await requireMiraBrowserAccess(context(client, query, grant), {
            id: request.accessId,
            hostToken: request.hostToken,
            mode: "view",
        });
        const [limits] = await query<{ used: number; duplicate: boolean }[]>`
            SELECT count(*) FILTER(WHERE state<>'removed')::int AS used,coalesce(bool_or(access_id=${request.accessId}),false) AS duplicate FROM mira_browser_processes`;
        if (limits!.used >= 2 || limits!.duplicate)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Browser capacity is reserved; finish existing cleanup before starting another process."
            );
        let networkId: string | null = null;
        if (request.networkIds) {
            const used = await query<
                { networkId: string }[]
            >`SELECT network_id AS "networkId" FROM mira_browser_processes WHERE host_id=${request.hostId} AND state<>'removed' AND network_id IS NOT NULL`;
            networkId =
                request.networkIds.find(
                    (candidate) => !used.some((row) => row.networkId === candidate)
                ) ?? null;
            if (!networkId)
                throw new MiraFailure(
                    "PRECONDITION_FAILED",
                    "Browser networks are reserved until existing cleanup completes."
                );
        }
        const id = randomUUID(),
            token = randomUUID();
        await query`INSERT INTO mira_browser_processes(id,access_id,host_id,image_id,network_id,lease_token,lease_expires_at)
            VALUES(${id},${request.accessId},${request.hostId},${request.imageId},${networkId},${token},clock_timestamp()+interval '15 seconds')`;
        return result((await read(query, id))!);
    };
    return transaction ? reserve(transaction) : client.begin(reserve);
}

/**
 * Record create dispatch before calling Docker, or record its settled immutable container ID afterward.
 * @param client - Trusted host database connection.
 * @param claim - Exact private host/controller identity; expired or replaced controllers cannot advance.
 * @param input - The next one-way phase, with a validated container ID only after create returned.
 * @returns The updated private process record; this does not authorize browser input or perform Docker work.
 */
export async function advanceMiraBrowserProcess(
    client: SQL,
    claim: unknown,
    input: unknown
) {
    const step = v.parse(
        v.variant("phase", [
            v.strictObject({ phase: v.literal("creating") }),
            v.strictObject({ phase: v.literal("created"), containerId }),
        ]),
        input
    );
    return owned(client, claim, async (query, row) => {
        await active(client, query, row);
        if (
            (step.phase === "creating" && row.phase !== "reserved") ||
            (step.phase === "created" && row.phase !== "creating")
        )
            throw failure();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_processes SET phase=${step.phase},container_id=${step.phase === "created" ? step.containerId : null},lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${row.id} AND lease_expires_at>clock_timestamp() RETURNING id`;
        if (updated.length === 0) throw failure();
        return result((await read(query, row.id))!);
    });
}

/**
 * Renew a still-current creator lease while its original human/run grant remains valid.
 * @param client - Trusted host database connection.
 * @param claim - Exact host and controller token; expiry cannot be renewed into fresh authority.
 * @returns The bounded private lease record; callers must still check action-specific browser access.
 */
export async function renewMiraBrowserProcess(client: SQL, claim: unknown) {
    return owned(client, claim, async (query, row) => {
        await active(client, query, row);
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${row.id} AND lease_expires_at>clock_timestamp() RETURNING id`;
        if (updated.length === 0) throw failure();
        return result((await read(query, row.id))!);
    });
}

/**
 * Permanently fence creation/input and reserve cleanup for the current controller.
 * @param client - Trusted host database connection.
 * @param claim - Original host/controller token; it may clean up after grant or run expiry until replaced.
 * @returns A cleanup lease; repeated calls renew cleanup only and never revive execution.
 */
export async function beginMiraBrowserProcessCleanup(client: SQL, claim: unknown) {
    return owned(client, claim, async (query, row) => {
        if (row.state === "removed") return result(row);
        await stopGrant(query, row.accessId);
        await query`UPDATE mira_browser_processes SET state='cleanup',lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${row.id}`;
        return result((await read(query, row.id))!);
    });
}

/**
 * Take over one expired process on this persistent host without freeing its reserved capacity.
 * @param client - Trusted host database connection; not a human or agent API.
 * @param hostId - Configured stable identity for the local Docker engine.
 * @returns A rotated private cleanup lease, or null; old controllers become permanently fenced.
 */
export async function claimMiraBrowserProcessRecovery(client: SQL, hostId: string) {
    v.parse(uuid, hostId);
    return client.begin(async (query) => {
        const [candidate] = await query<{ id: string }[]>`
            SELECT id FROM mira_browser_processes WHERE host_id=${hostId} AND state<>'removed' AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,id LIMIT 1`;
        if (!candidate) return null;
        const initial = (await read(query, candidate.id))!;
        await lockOwner(query, initial.owner);
        const row = (await read(query, candidate.id))!;
        if (row.current || row.state === "removed") return null;
        await stopGrant(query, row.accessId);
        await query`UPDATE mira_browser_processes SET state='cleanup',lease_token=${randomUUID()},lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${row.id}`;
        return result((await read(query, row.id))!);
    });
}

/**
 * Persist settled creation rejection or an ownership-verified ID before destructive cleanup.
 * @param client - Trusted local host database connection.
 * @param claim - Current private cleanup lease; replacement and expiry fence this write.
 * @param input - An actual settled Engine rejection, or the verified immutable ID found by inspection.
 * @returns Durable recovery identity; interruption after deletion can then prove known absence.
 */
export async function recordMiraBrowserProcessCleanup(
    client: SQL,
    claim: unknown,
    input: unknown
) {
    const evidence = v.parse(
        v.variant("kind", [
            v.strictObject({
                kind: v.literal("rejected"),
                status: v.picklist([400, 404, 409]),
            }),
            v.strictObject({ kind: v.literal("discovered"), containerId }),
        ]),
        input
    );
    return owned(client, claim, async (query, row) => {
        if (row.state !== "cleanup" || !row.current) throw failure();
        if (evidence.kind === "rejected") {
            if (!["creating", "rejected"].includes(row.phase)) throw failure();
        } else if (
            row.phase === "reserved" ||
            (row.containerId && row.containerId !== evidence.containerId)
        )
            throw failure();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_processes SET phase=${evidence.kind === "rejected" ? "rejected" : "created"},container_id=${evidence.kind === "rejected" ? null : evidence.containerId},lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${row.id} AND lease_expires_at>clock_timestamp() RETURNING id`;
        if (updated.length === 0) throw failure();
        return result((await read(query, row.id))!);
    });
}

/**
 * Release capacity and the original grant only after trusted Docker reconciliation proved cleanup.
 * @param client - Trusted host database connection.
 * @param claim - Current cleanup controller lease for this exact local engine.
 * @param input - No-create evidence, or the exact removed/previously known absent container ID. Unknown create plus absence is insufficient.
 * @returns Atomic, idempotent cleanup completion; this helper never performs or infers Docker removal.
 */
export async function confirmMiraBrowserProcessCleanup(
    client: SQL,
    claim: unknown,
    input: unknown
): Promise<void> {
    const proof = v.parse(
        v.variant("kind", [
            v.strictObject({ kind: v.literal("not-created") }),
            v.strictObject({ kind: v.literal("rejected") }),
            v.strictObject({ kind: v.literal("removed"), containerId }),
            v.strictObject({ kind: v.literal("absent"), containerId }),
        ]),
        input
    );
    await owned(client, claim, async (query, row) => {
        if (row.state === "removed") return;
        if (row.state !== "cleanup" || !row.current) throw failure();
        if (proof.kind === "not-created") {
            if (row.phase !== "reserved") throw failure();
        } else if (proof.kind === "rejected") {
            if (row.phase !== "rejected") throw failure();
        } else if (row.phase !== "created" || proof.containerId !== row.containerId)
            throw failure();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_processes SET state='removed',cleanup_evidence=${proof.kind},removed_at=clock_timestamp() WHERE id=${row.id} AND lease_expires_at>clock_timestamp() RETURNING id`;
        if (updated.length === 0) throw failure();
        await closeMiraBrowserAccess(context(client, query, row), {
            id: row.accessId,
            hostToken: row.hostToken,
        });
    });
}
