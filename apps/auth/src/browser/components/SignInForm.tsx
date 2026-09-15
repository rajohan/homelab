import { passwordPolicy } from "@homelab/contracts";
import { Switch, FieldsForm } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";
/**
 * Collect account credentials and continue only after a successful password check.
 * @returns The component's rendered content for its current state.
 */
export function SignInForm({
    client,
    onComplete,
}: {
    readonly client: IdentityClient;
    readonly onComplete: () => Promise<void>;
}) {
    const [remember, setRemember] = useState(false);
    return (
        <FieldsForm
            fields={[
                {
                    name: "username",
                    label: "Username",
                    placeholder: "Enter your username",
                    autoComplete: "username",
                    maximum: 100,
                },
                {
                    name: "password",
                    label: "Password",
                    placeholder: "Enter your password",
                    type: "password",
                    autoComplete: "current-password",
                    minimum: passwordPolicy.minimumLength,
                },
            ]}
            submitLabel="Sign in"
            onSubmit={async (values) => {
                await client.request("/api/login", {
                    username: values.username,
                    password: values.password,
                    remember,
                });
                await onComplete();
            }}
        >
            <Switch
                label="Remember me"
                checked={remember}
                onChange={setRemember}
                name="remember"
            />
        </FieldsForm>
    );
}
