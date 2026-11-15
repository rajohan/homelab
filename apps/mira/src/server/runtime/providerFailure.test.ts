import { expect, test } from "bun:test";

import {
    classifyProviderFailure,
    providerFailureMessage,
    ProviderRequestError,
} from "./providerFailure";

test("classifies observed and documented errors without exposing provider content", () => {
    expect(
        classifyProviderFailure({
            codexErrorInfo: "other",
            message: '{"detail":"Bad Request"}',
        })
    ).toBe("bad_request");
    expect(classifyProviderFailure({ codexErrorInfo: "contextWindowExceeded" })).toBe(
        "context_limit"
    );
    expect(classifyProviderFailure({ code: "context_length_exceeded" })).toBe(
        "context_limit"
    );
    expect(classifyProviderFailure({ codexErrorInfo: "usageLimitExceeded" })).toBe(
        "rate_limit"
    );
    expect(classifyProviderFailure({ codexErrorInfo: "unauthorized" })).toBe(
        "authentication"
    );
    expect(
        classifyProviderFailure({
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        })
    ).toBe("unavailable");
    expect(
        classifyProviderFailure({
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        })
    ).toBe("unavailable");
    for (const value of [
        null,
        false,
        "sensitive response",
        { message: "secret prompt", code: "custom" },
    ]) {
        expect(classifyProviderFailure(value)).toBe("unknown");
        expect(
            providerFailureMessage("OpenAI", classifyProviderFailure(value))
        ).not.toContain("secret");
    }
});

test.each([
    [400, "bad_request"],
    [401, "authentication"],
    [403, "authentication"],
    [413, "request_too_large"],
    [429, "rate_limit"],
    [500, "unavailable"],
    [503, "unavailable"],
    [404, "unknown"],
] as const)("maps HTTP %s to a safe message", (status, failure) => {
    expect(classifyProviderFailure(null, status)).toBe(failure);
    const error = new ProviderRequestError("Synthetic", failure);
    expect(error.message).toStartWith("Synthetic:");
    expect(error.message).toContain("Your conversation is saved.");
    expect(error.message).toContain("No actions were replayed.");
});
