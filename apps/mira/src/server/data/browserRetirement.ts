import type { TransactionSQL } from "bun";

/**
 * Scrub transient command content and stop its grant without claiming browser removal.
 * @param query - Transaction holding the account control lock.
 * @param owner - Verified account.
 * @param accessId - Exact grant; queued commands alone are known to be undelivered.
 * @returns Completion after content is erased; replay tombstones remain.
 */
export async function retireBrowserCommands(
    query: TransactionSQL,
    owner: string,
    accessId: string
): Promise<void> {
    await query`UPDATE mira_browser_consoles SET frame=NULL,frame_at=NULL,payload=NULL,state='idle',method=NULL,expires_at=NULL WHERE access_id=${accessId} AND EXISTS(SELECT 1 FROM mira_browser_access WHERE id=${accessId} AND owner=${owner})`;
    await query`UPDATE mira_browser_commands SET state=CASE WHEN state='queued' THEN 'refused' ELSE 'unknown' END,
        payload=NULL,result=NULL,finished_at=clock_timestamp() WHERE owner=${owner} AND access_id=${accessId} AND state IN ('queued','claimed','completed')`;
    await query`UPDATE mira_browser_access SET state=CASE WHEN state='pending' THEN 'closed' ELSE 'stopping' END,policy=NULL,
        closed_at=CASE WHEN state='pending' THEN clock_timestamp() ELSE NULL END
        WHERE id=${accessId} AND owner=${owner} AND state IN ('pending','active')`;
}
