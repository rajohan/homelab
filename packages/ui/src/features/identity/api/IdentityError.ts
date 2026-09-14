export class IdentityError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "IdentityError";
        this.code = code;
        this.status = status;
    }
}
