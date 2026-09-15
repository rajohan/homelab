import type { ReactNode } from "react";

export function SuccessNotice({ children }: { readonly children: ReactNode }) {
    return (
        <output className="block rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-300">
            {children}
        </output>
    );
}
