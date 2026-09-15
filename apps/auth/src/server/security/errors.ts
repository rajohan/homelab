export class AuthFailure extends Error {
    readonly code: string;
    readonly status: number;
    /**
     * Represent an expected identity failure with safe HTTP feedback.
     * @param code - The stable error identifier.
     * @param status - The response status.
     * @param message - The nonsecret user-facing explanation.
     */
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "AuthFailure";
        this.code = code;
        this.status = status;
    }
}

/**
 * Reject an operation that requires a valid authenticated session.
 * @throws {Error} The current request is not authorized.
 */
export function denied(): never {
    throw new AuthFailure("UNAUTHORIZED", 401, "Sign in to continue.");
}

/**
 * Reject a missing, expired, consumed or invalid identity proof.
 * @throws {Error} The presented proof cannot authorize the operation.
 */
export function invalidProof(): never {
    throw new AuthFailure("INVALID_PROOF", 400, "The verification failed or expired.");
}

/**
 * Require a successful identity proof within the five-minute step-up window.
 * @param verifiedAt - The last accepted proof time, or null if absent.
 * @param now - The timestamp against which freshness is checked.
 * @throws {Error} The operation requires a fresh identity confirmation.
 */
export function requireRecent(verifiedAt: Date | null, now: Date): void {
    if (!verifiedAt || now.getTime() - verifiedAt.getTime() >= 5 * 60_000) {
        throw new AuthFailure(
            "STEP_UP_REQUIRED",
            403,
            "Confirm your identity to continue."
        );
    }
}
