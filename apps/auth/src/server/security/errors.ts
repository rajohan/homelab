export class AuthFailure extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "AuthFailure";
        this.code = code;
        this.status = status;
    }
}

export function denied(): never {
    throw new AuthFailure("UNAUTHORIZED", 401, "Sign in to continue.");
}

export function invalidProof(): never {
    throw new AuthFailure("INVALID_PROOF", 400, "The verification failed or expired.");
}

export function requireRecent(verifiedAt: Date | null, now: Date): void {
    if (!verifiedAt || now.getTime() - verifiedAt.getTime() >= 5 * 60_000) {
        throw new AuthFailure(
            "STEP_UP_REQUIRED",
            403,
            "Confirm your identity to continue."
        );
    }
}
