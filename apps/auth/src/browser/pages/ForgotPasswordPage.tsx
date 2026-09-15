import { FieldsForm } from "@homelab/ui";
import { useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
export function ForgotPasswordPage({ client }: AuthPageProps) {
    const [notice, setNotice] = useState("");
    return (
        <AuthLayout title="Reset your password" recovery>
            {notice && <output className="text-base text-emerald-300">{notice}</output>}
            <FieldsForm
                fields={[
                    {
                        name: "username",
                        label: "Username",
                        placeholder: "Enter your username",
                        autoComplete: "username",
                        maximum: 100,
                    },
                ]}
                submitLabel="Send reset link"
                onSubmit={async (values) => {
                    await client.request("/api/password/request-reset", {
                        username: values.username,
                    });
                    setNotice(
                        "If your account has a verified email, a reset link will be sent."
                    );
                }}
            />
        </AuthLayout>
    );
}
