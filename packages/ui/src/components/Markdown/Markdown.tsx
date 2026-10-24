import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

/**
 * Render untrusted Markdown without raw HTML, executable URLs or remote image loads.
 * @returns A responsive document using the shared typography and surface colors.
 */
export function Markdown({
    children,
    tone = "default",
}: {
    readonly children: string;
    readonly tone?: "default" | "onAccent";
}) {
    return (
        <div
            className={`prose prose-sm max-w-none wrap-anywhere prose-invert prose-code:before:content-none prose-code:after:content-none prose-pre:overflow-x-auto prose-pre:bg-primary-950/60 [&_table]:block [&_table]:overflow-x-auto ${tone === "onAccent" ? "prose-headings:text-white prose-p:text-white prose-a:text-white prose-strong:text-white prose-code:text-white prose-th:text-white prose-td:text-white/90" : "prose-headings:text-primary-100 prose-p:text-primary-200 prose-a:text-accent-300 prose-th:text-primary-200 prose-td:text-primary-300"}`}
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ pre: MarkdownCodeBlock }}
                skipHtml
                disallowedElements={["img"]}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}
