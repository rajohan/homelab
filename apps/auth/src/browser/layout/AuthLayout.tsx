import { Card } from "@homelab/ui";
import type { ReactNode } from "react";
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
        <main className="grid min-h-screen place-items-center px-4 py-10">
            <div className="w-full max-w-md space-y-5">
                <a
                    className="block text-center text-2xl font-semibold tracking-tight text-blue-900"
                    href="/sign-in"
                >
                    Homelab
                </a>
                <Card className="space-y-5">
                    <h1 className="text-2xl font-semibold">{title}</h1>
                    {children}
                    <a
                        className="block text-sm text-blue-700 underline"
                        href={recovery ? "/sign-in" : "/forgot-password"}
                    >
                        {recovery ? "Return to sign in" : "Forgot your password?"}
                    </a>
                </Card>
            </div>
        </main>
    );
}
