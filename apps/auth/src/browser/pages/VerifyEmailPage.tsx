import { ErrorNotice, LoadingState } from "@homelab/ui";
import { useEffect, useRef, useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
/**
 * Redeem a verification link once in the browser, then return to the account entry page.
 * @returns Verification progress or an actionable failure without an extra confirmation button.
 */
export function VerifyEmailPage({ client, token }: AuthPageProps) {
    const [verificationError, setError] = useState<unknown>();
    const pending = useRef<
        | {
              client: AuthPageProps["client"];
              token: string;
              promise: Promise<unknown>;
          }
        | undefined
    >(undefined);
    useEffect(() => {
        if (!token) return;
        let active = true;
        // Strict Mode repeats effect setup. The one-use proof must not be submitted twice.
        if (pending.current?.client !== client || pending.current.token !== token)
            pending.current = {
                client,
                token,
                promise: client.request("/api/email/verify", { token }),
            };
        void pending.current.promise.then(
            () => {
                if (!active) return;
                try {
                    sessionStorage.setItem("homelab.email-verified", "true");
                } catch {
                    // Storage privacy settings must not prevent a completed verification.
                }
                globalThis.location.replace("/");
                return;
            },
            (error: unknown) => {
                if (active) setError(error);
            }
        );
        return () => {
            active = false;
        };
    }, [client, token]);
    return (
        <AuthLayout title="Verify your email" recovery>
            {Boolean(verificationError) && (
                <div className="space-y-3">
                    <ErrorNotice error={verificationError} />
                    <p className="text-sm text-primary-300">
                        You can request a new verification link in account settings.
                    </p>
                    <a href="/account" className="text-accent-300 underline">
                        Account settings
                    </a>
                </div>
            )}
            {!verificationError && token && <LoadingState label="Verifying your email" />}
            {!verificationError && !token && (
                <p role="alert">
                    This verification link is missing its token. Request another email.
                </p>
            )}
        </AuthLayout>
    );
}
