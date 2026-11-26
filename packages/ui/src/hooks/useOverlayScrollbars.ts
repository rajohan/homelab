import { OverlayScrollbars } from "overlayscrollbars";
import { type RefObject, useEffect } from "react";

import { useMediaQuery } from "./useMediaQuery";

/** Overlay a draggable thumb on the existing scrollport so full-width rows can paint underneath.
 * @param viewport - A native scroll element in a same-sized, positioned frame. Omit for the page.
 */
export function useOverlayScrollbars(viewport?: RefObject<HTMLElement | null>): void {
    const forcedColors = useMediaQuery("(forced-colors: active)");
    useEffect(() => {
        const target = viewport ? viewport.current : document.body;
        if (!target?.parentElement || forcedColors) return;
        const instance = OverlayScrollbars(
            // A track inside the moving viewport needs a counter-transform on every scroll.
            // Mount it on the stationary, positioned frame that surrounds the viewport.
            viewport
                ? {
                      target,
                      elements: { viewport: target },
                      scrollbars: { slot: target.parentElement },
                  }
                : target,
            {
                overflow: { x: viewport ? "scroll" : "hidden", y: "scroll" },
                scrollbars: { theme: "os-theme-homelab", clickScroll: "instant" },
            }
        );
        return () => instance.destroy();
    }, [viewport, forcedColors]);
}
