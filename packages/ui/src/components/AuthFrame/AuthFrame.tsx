import type { ReactNode } from "react";

import { Brand } from "../Brand/Brand";
import { Card } from "../Card/Card";

/**
 * Provide the shared responsive frame for sign-in and account-recovery screens.
 * @returns The component's rendered content for its current state.
 */
export function AuthFrame({
    title,
    description,
    children,
    footer,
}: {
    readonly title: string;
    readonly description?: ReactNode;
    readonly children: ReactNode;
    readonly footer?: ReactNode;
}) {
    return (
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 sm:py-16">
            <div className="w-full max-w-md">
                <div className="mb-8 flex justify-center">
                    <Brand subtitle="Your homelab. One account." />
                </div>
                <Card className="overflow-hidden p-0 shadow-xl shadow-black/10 sm:p-0">
                    <div className="border-b border-primary-700 bg-primary-900/30 px-6 py-5 sm:px-8 sm:py-6">
                        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                        {description && (
                            <p className="mt-2 text-sm leading-6 text-primary-400">
                                {description}
                            </p>
                        )}
                    </div>
                    <div className="space-y-5 p-6 sm:p-8">{children}</div>
                    {footer && (
                        <div className="border-t border-primary-700 px-6 py-4 text-center text-sm">
                            {footer}
                        </div>
                    )}
                </Card>
                <p className="mt-6 text-center text-xs text-primary-500">
                    Homelab Identity · Rajohan
                </p>
            </div>
        </main>
    );
}
