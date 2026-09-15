import { AuthFrame, Button } from "@homelab/ui";

/**
 * Explain a declined authorization without automatically restarting the consent flow.
 * @returns A deliberate retry action that preserves the requested dashboard path.
 */
export function AuthorizationDeclined() {
    const returnTo =
        new URLSearchParams(globalThis.location.search).get("returnTo") ?? "/settings";
    return (
        <AuthFrame title="Access not approved">
            <p className="text-sm leading-6 text-primary-300">
                You declined this sign-in request. You can try again whenever you are
                ready.
            </p>
            <Button
                fullWidth
                onClick={() =>
                    globalThis.location.replace(
                        "/login?" + new URLSearchParams({ returnTo }).toString()
                    )
                }
            >
                Try again
            </Button>
        </AuthFrame>
    );
}
