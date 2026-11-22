import { ListTree } from "lucide-react";
import { type RefObject, useSyncExternalStore } from "react";

import { Select } from "./Select";

/** Navigate the open sections of one scroll container and reflect the section currently in view.
 * @returns A keyboard-accessible picker that keeps all sections mounted.
 */
export function SectionJumpMenu({
    sections,
    scrollRef,
    label,
}: {
    readonly sections: readonly { value: string; label: string }[];
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly label: string;
}) {
    const first = sections[0]?.value ?? "";
    function headings(root: HTMLElement) {
        return sections
            .map(({ value }) => root.querySelector<HTMLElement>(`#${CSS.escape(value)}`))
            .filter((el) => el !== null);
    }
    function current() {
        const root = scrollRef.current;
        if (!root) return first;
        const entries = headings(root);
        const bounds = root.getBoundingClientRect();
        const focused = root.ownerDocument.activeElement;
        if (focused && root.contains(focused)) {
            const position = focused.getBoundingClientRect();
            const panel = focused.closest("section[aria-labelledby]");
            const heading = entries.find(
                (el) => el.id === panel?.getAttribute("aria-labelledby")
            );
            if (heading && position.top >= bounds.top && position.top < bounds.bottom)
                return heading.id;
        }
        const top = bounds.top + 24;
        const atEnd =
            root.scrollTop > 0 &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
        const entry = atEnd
            ? entries.at(-1)
            : entries.findLast((el) => el.getBoundingClientRect().top <= top);
        return entry?.id ?? first;
    }
    function subscribe(notify: () => void) {
        const root = scrollRef.current;
        if (!root) return () => {};
        root.addEventListener("scroll", notify, { passive: true });
        root.addEventListener("focusin", notify);
        const observer = new ResizeObserver(notify);
        observer.observe(root);
        for (const heading of headings(root)) {
            const section = heading.closest("section");
            if (section) observer.observe(section);
        }
        return () => {
            root.removeEventListener("scroll", notify);
            root.removeEventListener("focusin", notify);
            observer.disconnect();
        };
    }
    const active = useSyncExternalStore(subscribe, current, () => first);
    return (
        <Select
            label={label}
            compact
            icon={ListTree}
            options={sections}
            value={active}
            onChange={(id) => {
                const heading = scrollRef.current?.querySelector<HTMLElement>(
                    `#${CSS.escape(id)}`
                );
                if (!heading) return;
                requestAnimationFrame(() => {
                    heading.focus({ preventScroll: true });
                    heading.scrollIntoView({ block: "start" });
                });
            }}
        />
    );
}
