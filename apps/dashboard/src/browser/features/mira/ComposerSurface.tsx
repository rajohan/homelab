import type { ReactNode } from "react";

/** Give both the first message and replies the same writing surface.
 * @returns A consistent, focus-aware container for composer content.
 */
export function ComposerSurface({ children }: { readonly children: ReactNode }) {
    return (
        <div className="rounded-2xl border border-primary-600 bg-surface-card p-2 shadow-sm transition-colors focus-within:border-accent-400/70 sm:p-3">
            {children}
        </div>
    );
}
