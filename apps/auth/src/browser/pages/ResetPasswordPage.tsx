import { PasswordForm } from "@homelab/ui/identity";
import { useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
export function ResetPasswordPage({ client, token }: AuthPageProps) {
    const [notice, setNotice] = useState("");
    return (
        <AuthLayout title="Choose a new password" recovery>
            {notice && <output className="text-base text-emerald-300">{notice}</output>}
            {token ? (
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
            ) : (
                <p role="alert">
                    This reset link is missing its token. Request another email.
                </p>
            )}
        </AuthLayout>
    );
}
