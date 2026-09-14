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
    getSnapshot = (): number => this.#active;
    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    };
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
    complete(generation: number): void {
        if (generation === this.#active && generation !== 0) this.#finish(true);
    }
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
