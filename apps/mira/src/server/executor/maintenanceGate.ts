/** Keep new local work behind a deployment fence while already admitted operations finish. */
export class MaintenanceGate {
    private current: string | null | undefined;
    private active = 0;

    /**
     * Install the latest durable deployment identity before publishing any drain acknowledgement.
     * @param id - Active deployment ID, or null when normal work is permitted.
     */
    update(id: string | null): void {
        this.current = id;
    }

    /**
     * Read the deployment that has stopped admission and finished every admitted operation.
     * @returns Its exact identity, or null while uninitialized, accepting work or still busy.
     */
    get drained(): string | null {
        return this.current && this.active === 0 ? this.current : null;
    }

    /**
     * Admit one operation synchronously with the local fence and retain it through failure cleanup.
     * @param operation - Existing bounded work, including its awaited resource cleanup.
     * @returns The operation result, or undefined when deployment has paused new work.
     */
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
        if (this.current !== null) return undefined;
        this.active++;
        try {
            return await operation();
        } finally {
            this.active--;
        }
    }
}
