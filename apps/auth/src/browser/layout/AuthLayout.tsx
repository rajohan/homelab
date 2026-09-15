import { AuthFrame } from "@homelab/ui";
import type { ReactNode } from "react";

/**
 * Wrap authentication pages with the appropriate sign-in or recovery navigation.
 * @returns The component's rendered content for its current state.
 */
export function AuthLayout({
    title,
    description,
    children,
    recovery = false,
    authenticated = false,
}: {
    readonly title: string;
    readonly description?: string | undefined;
    readonly children: ReactNode;
    readonly recovery?: boolean;
    readonly authenticated?: boolean;
}) {
    const recoveryNavigation = {
        description: "Recover access to your Homelab account.",
        href: "/sign-in",
        label: "Return to sign in",
    };
    const signInNavigation = {
        description: "Use your account to continue to your homelab.",
        href: "/forgot-password",
        label: "Forgot your password?",
    };
    const signedOutNavigation = recovery ? recoveryNavigation : signInNavigation;
    const navigation = authenticated
        ? {
              description: "Your account is ready to use.",
              href: "/account",
              label: "Manage account security",
          }
        : signedOutNavigation;
    return (
        <AuthFrame
            title={title}
            description={description ?? navigation.description}
            footer={
                <a
                    className="rounded text-accent-300 underline-offset-4 hover:text-accent-200 hover:underline"
                    href={navigation.href}
                >
                    {navigation.label}
                </a>
            }
        >
            {children}
        </AuthFrame>
    );
}
