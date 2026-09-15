import { useEffect } from "react";

import { LoadingState } from "../Loading/LoadingState";

/**
 * Replace the current history entry with a caller-validated destination.
 * @returns An accessible pending state while the browser navigates.
 */
export function Redirect({ to, label = "Redirecting…" }: { to: string; label?: string }) {
    useEffect(() => {
        let active = true;
        // Cancel abandoned renders and React's development-only effect replay.
        queueMicrotask(() => {
            if (active) globalThis.location.replace(to);
        });
        return () => {
            active = false;
        };
    }, [to]);
    return <LoadingState label={label} />;
}
