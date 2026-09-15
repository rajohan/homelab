import { AuthFrame } from "@homelab/ui";
import type { ReactNode } from "react";

/**
 * Wrap authentication pages with the appropriate sign-in or recovery navigation.
 * @returns The component's rendered content for its current state.
 */
export function AuthLayout({
    title,
    children,
    recovery = false,
}: {
    readonly title: string;
    readonly children: ReactNode;
    readonly recovery?: boolean;
}) {
    return (
        <AuthFrame
            title={title}
            description={
                recovery
                    ? "Recover access to your Homelab account."
                    : "Use your account to continue to your homelab."
            }
            footer={
                <a
                    className="rounded text-accent-300 underline-offset-4 hover:text-accent-200 hover:underline"
                    href={recovery ? "/sign-in" : "/forgot-password"}
                >
                    {recovery ? "Return to sign in" : "Forgot your password?"}
                </a>
            }
        >
            {children}
        </AuthFrame>
    );
}
