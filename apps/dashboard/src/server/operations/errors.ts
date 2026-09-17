export class OperationFailure extends Error {
    readonly code:
        | "FORBIDDEN"
        | "UNAUTHORIZED"
        | "CONFLICT"
        | "NOT_FOUND"
        | "TOO_MANY_REQUESTS"
        | "PRECONDITION_FAILED"
        | "BAD_REQUEST";
    /**
     * Describe a safe application failure without attaching private upstream output.
     * @param code - A stable public failure category.
     * @param message - Operator-safe explanatory text.
     */
    constructor(code: OperationFailure["code"], message: string) {
        super(message);
        this.code = code;
        this.name = "OperationFailure";
    }
}
