import { OverlayScrollbars } from "overlayscrollbars";
import { type RefObject, useEffect } from "react";

import { useMediaQuery } from "./useMediaQuery";

/** Overlay a draggable thumb on the existing scrollport so full-width rows can paint underneath.
 * @param viewport - The native scroll element used by its callers, or the page when omitted.
 */
export function useOverlayScrollbars(viewport?: RefObject<HTMLElement | null>): void {
    const forcedColors = useMediaQuery("(forced-colors: active)");
    useEffect(() => {
        const target = viewport ? viewport.current : document.body;
        if (!target || forcedColors) return;
        const instance = OverlayScrollbars(
            viewport ? { target, elements: { viewport: target } } : target,
            {
                overflow: { x: viewport ? "scroll" : "hidden", y: "scroll" },
                scrollbars: { theme: "os-theme-homelab", clickScroll: "instant" },
            }
        );
        return () => instance.destroy();
    }, [viewport, forcedColors]);
}
