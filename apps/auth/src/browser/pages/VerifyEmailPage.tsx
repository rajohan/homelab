import { FieldsForm, SuccessNotice } from "@homelab/ui";
import { useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
/**
 * Redeem the current email-verification proof and display its result.
 * @returns The component's rendered content for its current state.
 */
export function VerifyEmailPage({ client, token }: AuthPageProps) {
    const [notice, setNotice] = useState("");
    return (
        <AuthLayout title="Verify your email" recovery>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
            {!notice && token && (
                <FieldsForm
                    fields={[]}
                    submitLabel="Verify email"
                    onSubmit={async () => {
                        await client.request("/api/email/verify", { token });
                        setNotice("Your email has been verified.");
                    }}
                />
            )}
            {!notice && !token && (
                <p role="alert">
                    This verification link is missing its token. Request another email.
                </p>
            )}
        </AuthLayout>
    );
}
