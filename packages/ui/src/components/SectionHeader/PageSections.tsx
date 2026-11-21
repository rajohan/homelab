import { type ReactNode, useContext, useEffect, useRef } from "react";

import { DeferredPageContent } from "./DeferredPageContent";
import { PageOutlineContext } from "./pageOutlineContext";

interface PageSection {
    readonly id: string;
    readonly label: string;
    readonly content: ReactNode;
    readonly width?: "half" | "full";
}

/** Render the entire page in reading order and publish optional shortcuts to its navigation.
 * @returns Linked section landmarks that preserve native scrolling, focus and fragment URLs.
 */
export function PageSections({
    label,
    sections,
    deferBelowFold = false,
}: {
    readonly label: string;
    readonly deferBelowFold?: boolean;
    readonly sections: readonly PageSection[];
}) {
    const page = useRef<HTMLDivElement>(null);
    const publish = useContext(PageOutlineContext);
    useEffect(() => {
        const root = page.current;
        if (!root) return;
        const landmarks = [...root.children].filter(
            (node): node is HTMLElement => node instanceof HTMLElement
        );
        const items = landmarks.map((node) => ({
            id: node.id,
            label: node.getAttribute("aria-label") ?? node.id,
        }));
        const path = globalThis.location.pathname;
        let frame = 0;
        let current: string | undefined;
        let target: HTMLElement | null = null;
        const releaseTarget = () => {
            target = null;
        };
        const releaseForKey = (event: KeyboardEvent) => {
            if (
                [
                    "ArrowUp",
                    "ArrowDown",
                    "PageUp",
                    "PageDown",
                    "Home",
                    "End",
                    " ",
                    "Tab",
                ].includes(event.key)
            )
                releaseTarget();
        };
        const update = () => {
            frame = 0;
            const position = landmarks.findLast(
                (node) => node.getBoundingClientRect().top <= 88
            );
            // Sibling columns share a reading position until a shortcut selects one explicitly.
            const rowStart =
                position &&
                landmarks.find((node) => node.offsetTop === position.offsetTop);
            const atEnd =
                globalThis.scrollY > 0 &&
                Math.ceil(globalThis.scrollY + document.documentElement.clientHeight) >=
                    document.documentElement.scrollHeight;
            const selected = target && landmarks.find((node) => node.contains(target));
            const visible = atEnd ? landmarks.at(-1) : rowStart;
            const next = selected?.id ?? visible?.id ?? items[0]?.id ?? "";
            if (current !== next) {
                current = next;
                publish?.({ path, label, items, current: next });
            }
        };
        const queue = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        const alignTarget = () => {
            if (target) target.scrollIntoView({ block: "start" });
            queue();
        };
        const readTarget = () => {
            const fragment = globalThis.location.hash.slice(1);
            target = fragment
                ? root.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)
                : null;
            alignTarget();
        };
        readTarget();
        const observer = new ResizeObserver(alignTarget);
        for (const node of landmarks) observer.observe(node);
        globalThis.addEventListener("scroll", queue, { passive: true });
        globalThis.addEventListener("resize", queue);
        globalThis.addEventListener("hashchange", readTarget);
        globalThis.addEventListener("wheel", releaseTarget, { passive: true });
        globalThis.addEventListener("pointerdown", releaseTarget, { passive: true });
        globalThis.addEventListener("keydown", releaseForKey);
        return () => {
            globalThis.removeEventListener("scroll", queue);
            globalThis.removeEventListener("resize", queue);
            globalThis.removeEventListener("hashchange", readTarget);
            globalThis.removeEventListener("wheel", releaseTarget);
            globalThis.removeEventListener("pointerdown", releaseTarget);
            globalThis.removeEventListener("keydown", releaseForKey);
            observer.disconnect();
            cancelAnimationFrame(frame);
            publish?.((previous) => (previous?.path === path ? null : previous));
        };
    }, [label, publish, sections.length]);
    return (
        <div className="@container/page-sections min-w-0">
            <div
                ref={page}
                className="grid min-w-0 gap-5 @min-[54rem]/page-sections:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
            >
                {sections.map((section, index) => (
                    <section
                        key={section.id}
                        id={section.id}
                        tabIndex={-1}
                        aria-label={section.label}
                        className={`min-w-0 scroll-mt-18 focus-visible:outline-2 focus-visible:outline-accent-300 ${section.width === "half" ? "[&>section]:h-full" : "col-span-full"}`}
                    >
                        {deferBelowFold && index > 0 ? (
                            <DeferredPageContent label={section.label}>
                                {section.content}
                            </DeferredPageContent>
                        ) : (
                            section.content
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
}
