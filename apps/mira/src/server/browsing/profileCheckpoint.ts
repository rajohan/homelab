import type { BrowserProfilePersistence } from "./profile";
import { browserProfileSnapshot } from "./profileSnapshot";
import { BrowserProfileTransfer } from "./profileTransfer";

/** Private shutdown-only receiver; incomplete or invalid snapshots never replace stored data. */
export class BrowserProfileCheckpoint {
    private readonly transfer = new BrowserProfileTransfer();
    private readonly result = Promise.withResolvers<string | null>();
    private stopped = false;
    private started = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    /** Start one bounded window after input has been permanently revoked. */
    start(): void {
        if (this.started || this.stopped) return;
        this.started = true;
        this.timer = setTimeout(() => this.cancel(), 4500);
    }

    /**
     * Accept one private chunk only during shutdown.
     * @param part - Untrusted checkpoint data from the worker.
     */
    receive(part: unknown): void {
        if (!this.started || this.stopped)
            throw new Error("Unexpected browser checkpoint.");
        const snapshot = this.transfer.accept(part);
        if (snapshot === undefined) return;
        if (snapshot === null) throw new Error("Empty browser checkpoint.");
        browserProfileSnapshot(snapshot);
        this.stopped = true;
        clearTimeout(this.timer);
        this.result.resolve(snapshot);
    }

    /** Discard incomplete data on stream failure or deadline without changing the previous profile. */
    cancel(): void {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.timer);
        this.result.resolve(null);
    }

    /**
     * Wait for completion and save under the host's current cleanup lease.
     * @param persistence - Private database callback that fences removed and replaced controllers.
     * @returns Completion within the shutdown budget, including uncertain database writes.
     */
    async persist(persistence: BrowserProfilePersistence): Promise<void> {
        this.start();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.result.promise.then(async (snapshot) => {
                    return snapshot === null ? undefined : persistence.save(snapshot);
                }),
                new Promise<void>((resolve) => {
                    deadline = setTimeout(resolve, 4500);
                }),
            ]);
        } finally {
            clearTimeout(deadline);
            this.cancel();
        }
    }
}
