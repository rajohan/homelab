/** A sanitized protocol failure; private provider diagnostics never leave the transport. */
export class RuntimeResponseError extends Error {
    readonly threadMissing: boolean;
    /**
     * Preserve a safe code and an exactly matched missing-thread outcome for deletion or conversation recovery.
     * @param code - Numeric JSON-RPC error code.
     * @param threadMissing - True only for the exact requested thread's not-found response.
     */
    constructor(code: number, threadMissing = false) {
        super(`Mira runtime rejected the request (${code}).`);
        this.name = "RuntimeResponseError";
        this.threadMissing = threadMissing;
    }
}
