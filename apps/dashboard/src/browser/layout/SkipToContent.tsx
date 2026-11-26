import { useEffect, useRef } from "react";

/** Reveal the skip link for Tab navigation and move focus to the main landmark.
 * @returns The dashboard's keyboard shortcut past the navigation.
 */
export function SkipToContent() {
    const link = useRef<HTMLAnchorElement>(null);
    useEffect(() => {
        const element = link.current;
        if (!element) return;
        const clear = () => {
            delete element.dataset.keyboard;
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Tab") return;
            if (event.type === "keydown" || document.activeElement === element)
                element.dataset.keyboard = "";
            else clear();
        };
        globalThis.addEventListener("keydown", onKey, true);
        globalThis.addEventListener("keyup", onKey, true);
        globalThis.addEventListener("pointerdown", clear, true);
        globalThis.addEventListener("blur", clear);
        return () => {
            globalThis.removeEventListener("keydown", onKey, true);
            globalThis.removeEventListener("keyup", onKey, true);
            globalThis.removeEventListener("pointerdown", clear, true);
            globalThis.removeEventListener("blur", clear);
        };
    }, []);
    return (
        <a
            ref={link}
            className="fixed top-3 left-3 z-50 -translate-y-24 rounded-lg bg-accent-700 px-4 py-3 text-sm font-semibold text-white data-keyboard:focus:translate-y-0"
            href="#main-content"
            onClick={(event) => {
                const main = document.querySelector<HTMLElement>("#main-content");
                if (main) {
                    event.preventDefault();
                    main.focus({ preventScroll: true });
                    main.scrollIntoView({ block: "start" });
                }
            }}
        >
            Skip to content
        </a>
    );
}
