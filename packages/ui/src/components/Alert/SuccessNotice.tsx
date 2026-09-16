import type { ReactNode } from "react";

/**
 * Present success feedback in a polite live output region near its action.
 * @returns The component's rendered content for its current state.
 */
export function SuccessNotice({ children }: { readonly children: ReactNode }) {
    return (
        <output className="block rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-300">
            {children}
        </output>
    );
}
