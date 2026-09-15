interface Waiter {
    readonly resolve: (accepted: boolean) => void;
    readonly release: () => void;
}
export class VerificationCoordinator {
    readonly #listeners = new Set<() => void>();
    readonly #waiters = new Set<Waiter>();
    #generation = 0;
    #active = 0;
    #timeout: ReturnType<typeof setTimeout> | undefined;
    /**
     * Read the active verification generation for the external-store subscription.
     * @returns The active generation, or zero when no prompt is open.
     */
    getSnapshot = (): number => this.#active;
    /**
     * Observe changes to the shared verification prompt.
     * @param listener - The callback notified when prompt state changes.
     * @returns An unsubscribe callback.
     */
    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    };
    /**
     * Join one shared verification prompt and wait for its result.
     * @param signal - Optional cancellation signal for this pending action.
     * @returns Whether the matching verification generation completed successfully.
     */
    request(signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return Promise.resolve(false);
        if (!this.#active) {
            this.#generation += 1;
            this.#active = this.#generation;
            this.#timeout = setTimeout(() => this.cancel(), 600_000);
        }
        const pending = Promise.withResolvers<boolean>();
        const abort = () => {
            this.#waiters.delete(waiter);
            waiter.release();
            pending.resolve(false);
            if (this.#waiters.size === 0) this.cancel();
        };
        const waiter: Waiter = {
            resolve: pending.resolve,
            release: () => signal?.removeEventListener("abort", abort),
        };
        this.#waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        for (const listener of this.#listeners) listener();
        return pending.promise;
    }
    /**
     * Resolve pending actions only for the current verification generation.
     * @param generation - The generation whose proof just succeeded.
     */
    complete(generation: number): void {
        if (generation === this.#active && generation !== 0) this.#finish(true);
    }
    /**
     * Close the prompt and release pending actions without accepting their proof.
     */
    cancel(): void {
        this.#finish(false);
    }
    #finish(accepted: boolean): void {
        const waiters = [...this.#waiters];
        this.#waiters.clear();
        this.#active = 0;
        clearTimeout(this.#timeout);
        this.#timeout = undefined;
        for (const waiter of waiters) {
            waiter.release();
            waiter.resolve(accepted);
        }
        for (const listener of this.#listeners) listener();
    }
}
