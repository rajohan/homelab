import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Present untrusted Markdown as plain text while retaining paragraph breaks.
 * @returns Phrasing-only content suitable for compact summaries and work notes.
 */
export function MarkdownText({ children }: { readonly children: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            allowedElements={["p", "br"]}
            unwrapDisallowed
            components={{
                p: ({ children }) => <span className="block">{children}</span>,
            }}
        >
            {children}
        </ReactMarkdown>
    );
}
