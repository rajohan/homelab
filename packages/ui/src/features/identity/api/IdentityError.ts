export class IdentityError extends Error {
    readonly code: string;
    readonly status: number;
    /**
     * Represent an identity API failure with safe feedback and a machine-readable code.
     * @param code - The stable identity error code.
     * @param status - The HTTP response status.
     * @param message - The user-facing error message.
     */
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "IdentityError";
        this.code = code;
        this.status = status;
    }
}
