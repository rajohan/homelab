import { FieldsForm } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
export function SignInForm({
    client,
    onComplete,
}: {
    readonly client: IdentityClient;
    readonly onComplete: () => Promise<void>;
}) {
    return (
        <FieldsForm
            fields={[
                {
                    name: "username",
                    label: "Username",
                    autoComplete: "username",
                    maximum: 100,
                },
                {
                    name: "password",
                    label: "Password",
                    type: "password",
                    autoComplete: "current-password",
                    minimum: 8,
                },
            ]}
            submitLabel="Sign in"
            onSubmit={async (values) => {
                await client.request("/api/login", {
                    username: values.username,
                    password: values.password,
                });
                await onComplete();
            }}
        />
    );
}
