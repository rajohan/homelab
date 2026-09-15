import { SuccessNotice } from "@homelab/ui";
import { PasswordForm } from "@homelab/ui/identity";
import { useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
export function ResetPasswordPage({ client, token }: AuthPageProps) {
    const [notice, setNotice] = useState("");
    return (
        <AuthLayout title="Choose a new password" recovery>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
            {!notice && token && (
                <PasswordForm
                    submitLabel="Reset password"
                    onSubmit={async (values) => {
                        await client.request("/api/password/reset", {
                            token,
                            password: values.newPassword,
                        });
                        setNotice(
                            "Your password was reset. Sign in using your existing two-factor method."
                        );
                    }}
                />
            )}
            {!notice && !token && (
                <p role="alert">
                    This reset link is missing its token. Request another email.
                </p>
            )}
        </AuthLayout>
    );
}
