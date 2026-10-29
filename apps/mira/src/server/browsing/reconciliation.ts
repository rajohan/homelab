import * as v from "valibot";

import { BrowserContainerCleanupError, type BrowserContainerProof } from "./container";
import type { BrowserDockerRequest } from "./docker";
import { browserEngine } from "./engine";

/**
 * Reconcile one durable local process without creating, attaching or replaying input.
 * @param configuration - Trusted local socket and the record's original immutable image.
 * @param input - Durable UUID, creation phase and returned ID, loaded from the private registry.
 * @param authorize - Revalidate the current cleanup controller before each mutation and final proof.
 * @param discovered - Persist the verified container ID before deletion makes it unobservable.
 * @param transport - Synthetic transport for isolated tests only.
 * @returns Evidence only after verified absence; unknown creation plus not-found remains reserved.
 */
export async function reconcileBrowserContainer(
    configuration: unknown,
    input: unknown,
    authorize: () => Promise<void>,
    discovered: (id: string) => Promise<void>,
    transport?: BrowserDockerRequest
): Promise<BrowserContainerProof> {
    const record = v.parse(
        v.strictObject({
            id: v.pipe(v.string(), v.uuid()),
            phase: v.picklist(["reserved", "creating", "created", "rejected"]),
            containerId: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
        }),
        input
    );
    if ((record.phase === "created") !== (record.containerId !== null))
        throw new Error("Invalid durable browser identity.");
    const engine = await browserEngine(configuration, transport);
    const name = `mira-browser-${record.id}`;
    await authorize();
    if (record.phase === "reserved") return { kind: "not-created" };
    const reference = record.containerId ?? name;
    const found = await engine.inspect(
        reference,
        record.id,
        record.containerId ?? undefined
    );
    if (!found) {
        if (!record.containerId && record.phase !== "rejected")
            throw new BrowserContainerCleanupError(name);
        await authorize();
        return record.containerId
            ? { kind: "absent", containerId: record.containerId }
            : { kind: "rejected" };
    }
    await authorize();
    await discovered(found);
    await authorize();
    const removed = await engine.call("DELETE", `/containers/${found}?force=1&v=1`);
    if (
        ![204, 404].includes(removed.status) ||
        (await engine.inspect(found, record.id, found))
    )
        throw new BrowserContainerCleanupError(name);
    await authorize();
    return { kind: "removed", containerId: found };
}
