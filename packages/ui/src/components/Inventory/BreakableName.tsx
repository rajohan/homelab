import type { ReactNode } from "react";

const boundaries =
    /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[/_])(?=[A-Za-z0-9])/gu;

/** Allow long identifiers to wrap between words and path segments while preserving their exact text.
 * @returns The original label with optional line breaks in plain-text names.
 */
export function BreakableName({ children }: { readonly children: ReactNode }) {
    if (typeof children !== "string") return children;
    const parts: ReactNode[] = [];
    let start = 0;
    for (const { index } of children.matchAll(boundaries)) {
        parts.push(children.slice(start, index), <wbr key={index} />);
        start = index;
    }
    if (start === 0) return children;
    return [...parts, children.slice(start)];
}
