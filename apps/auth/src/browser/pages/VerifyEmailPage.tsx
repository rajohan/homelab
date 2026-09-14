import { FieldsForm } from "@homelab/ui";
import { useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
export function VerifyEmailPage({ client, token }: AuthPageProps) {
    const [notice, setNotice] = useState("");
    return (
        <AuthLayout title="Verify your email" recovery>
            {notice && <output className="text-base text-emerald-800">{notice}</output>}
            {token ? (
                <FieldsForm
                    fields={[]}
                    submitLabel="Verify email"
                    onSubmit={async () => {
                        await client.request("/api/email/verify", { token });
                        setNotice("Your email has been verified.");
                    }}
                />
            ) : (
                <p role="alert">
                    This verification link is missing its token. Request another email.
                </p>
            )}
        </AuthLayout>
    );
}
