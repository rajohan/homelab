/** Provider failures are classified without returning upstream text, prompts or credentials. */
export type ProviderFailure =
    | "context_limit"
    | "request_too_large"
    | "bad_request"
    | "rate_limit"
    | "allowance"
    | "authentication"
    | "unavailable"
    | "incomplete"
    | "unknown";

/**
 * Classify documented provider codes and HTTP status without trusting their message text.
 * @param error - Untrusted Codex terminal error or a bounded HTTP error object.
 * @param status - HTTP status when supplied by the provider transport.
 * @returns A content-free category suitable for storage and display.
 */
export function classifyProviderFailure(
    error: unknown,
    status?: number
): ProviderFailure {
    const record =
        error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const code = record.codexErrorInfo ?? record.code;
    if (code === "contextWindowExceeded" || code === "context_length_exceeded")
        return "context_limit";
    if (status === 413 || code === "request_too_large") return "request_too_large";
    if (status === 401 || status === 403 || code === "unauthorized")
        return "authentication";
    if (status === 429 || code === "usageLimitExceeded" || code === "rate_limit_exceeded")
        return "rate_limit";
    if (
        status === 400 ||
        code === "badRequest" ||
        record.message === '{"detail":"Bad Request"}' ||
        record.message === 'Error running remote compact task: {"detail":"Bad Request"}'
    )
        return "bad_request";
    if (status !== undefined && status >= 500) return "unavailable";
    if (
        code &&
        typeof code === "object" &&
        ("httpConnectionFailed" in code || "responseStreamDisconnected" in code)
    )
        return "unavailable";
    return "unknown";
}

/**
 * Explain an observed provider failure without implying that completed tools were undone.
 * @param provider - Trusted provider display name.
 * @param failure - Classified failure; never raw upstream content.
 * @returns A stable message that preserves conversation continuity and action uncertainty.
 */
export function providerFailureMessage(
    provider: "OpenAI" | "Synthetic",
    failure: ProviderFailure
): string {
    const messages: Record<ProviderFailure, string> = {
        context_limit: "The conversation exceeded the model's context limit.",
        request_too_large: "The request exceeded the provider's size limit.",
        bad_request: "The provider rejected the request (Bad Request).",
        rate_limit:
            "The provider's usage or rate limit was reached. Check your allowance before continuing.",
        allowance:
            "The subscription allowance could not be verified. Check the connection and remaining allowance before continuing.",
        authentication:
            "The provider could not authorize this request. Check the connection in Settings.",
        unavailable:
            "The provider connection failed before a complete reply was confirmed.",
        incomplete: "The provider ended the reply before confirming completion.",
        unknown: "The provider could not complete the reply.",
    };
    return `${provider}: ${messages[failure]} Your conversation is saved. No actions were replayed.`;
}

/** A safe provider failure that may cross the executor's public error boundary. */
export class ProviderRequestError extends Error {
    readonly failure: ProviderFailure;
    /**
     * Create a classified error without retaining the upstream response body.
     * @param provider - Trusted provider display name.
     * @param failure - Content-free failure category.
     */
    constructor(provider: "OpenAI" | "Synthetic", failure: ProviderFailure) {
        super(providerFailureMessage(provider, failure));
        this.failure = failure;
    }
}
