import { type ReactNode, useEffect, useRef, useState } from "react";

/** Start a secondary workspace panel when it approaches the viewport and retain its local state thereafter.
 * @returns The panel or a reserved landing area for its section link.
 */
export function DeferredPageContent({
    label,
    children,
}: {
    readonly label: string;
    readonly children: ReactNode;
}) {
    const region = useRef<HTMLDivElement>(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const root = region.current;
        if (!root) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setReady(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "320px 0px" }
        );
        observer.observe(root);
        return () => observer.disconnect();
    }, []);
    return ready ? (
        children
    ) : (
        <div
            ref={region}
            className="min-h-56 rounded-xl border border-primary-700 bg-surface-card p-4"
            aria-busy="true"
        >
            <p className="text-sm font-medium text-primary-400">{label}</p>
        </div>
    );
}
