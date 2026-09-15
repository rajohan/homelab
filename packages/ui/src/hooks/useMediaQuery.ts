import { useSyncExternalStore } from "react";

/**
 * Observe a responsive media query without changing the DOM's visual and keyboard order independently.
 * @param query - The CSS media query to observe.
 * @returns Whether the current viewport matches; server rendering starts with the compact layout.
 */
export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (notify) => {
            const media = globalThis.matchMedia(query);
            media.addEventListener("change", notify);
            return () => media.removeEventListener("change", notify);
        },
        () => globalThis.matchMedia(query).matches,
        () => false
    );
}
