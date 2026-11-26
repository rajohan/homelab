import { OverlayScrollbars } from "overlayscrollbars";
import { type RefObject, useEffect } from "react";

import { useMediaQuery } from "./useMediaQuery";

/** Overlay a draggable thumb on the existing scrollport so full-width rows can paint underneath.
 * @param viewport - A native scroll element in a same-sized, positioned frame. Omit for the page.
 * @param stickyHeading - An optional heading inside the viewport that the vertical track must clear.
 */
export function useOverlayScrollbars(
    viewport?: RefObject<HTMLElement | null>,
    stickyHeading?: RefObject<HTMLElement | null>
): void {
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
        const heading = stickyHeading?.current;
        if (!heading) return () => instance.destroy();

        const track = instance.elements().scrollbarVertical.scrollbar;
        const alignTrack = () => {
            // In the stacked layout the column headings are only exposed to screen readers.
            track.style.top =
                getComputedStyle(heading).position === "sticky"
                    ? `${target.clientTop + heading.getBoundingClientRect().height}px`
                    : "";
        };
        alignTrack();
        const resize = new ResizeObserver(alignTrack);
        resize.observe(heading, { box: "border-box" });
        return () => {
            resize.disconnect();
            instance.destroy();
        };
    }, [viewport, stickyHeading, forcedColors]);
}
