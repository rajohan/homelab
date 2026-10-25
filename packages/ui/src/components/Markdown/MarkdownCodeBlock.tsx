import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";

import { CopyTextButton } from "../Button/CopyTextButton";
import { SyntaxSource } from "./SyntaxSource";

/**
 * Give fenced and indented code a language label and explicit copy action.
 * @returns A bounded code surface without nested pre elements or raw HTML insertion.
 */
export function MarkdownCodeBlock({
    node,
    children,
}: ComponentProps<"pre"> & ExtraProps) {
    const code = node?.children.find(
        (child) => child.type === "element" && child.tagName === "code"
    );
    if (!code || code.type !== "element") return <pre>{children}</pre>;
    const source = code.children
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("");
    const classes = code.properties.className;
    const language = Array.isArray(classes)
        ? String(
              classes.find(
                  (value) => typeof value === "string" && value.startsWith("language-")
              ) ?? ""
          )
              .slice(9)
              .toLowerCase()
        : "";
    return (
        <div className="not-prose my-4 min-w-0 overflow-hidden rounded-lg border border-primary-700 bg-primary-950">
            <div className="flex items-center justify-between gap-3 border-b border-primary-700 bg-primary-900/60 px-3 py-1">
                <span className="truncate font-mono text-xs text-primary-300">
                    {language || "text"}
                </span>
                <CopyTextButton
                    text={source}
                    label={`Copy ${language || "code"} block`}
                    iconOnly
                />
            </div>
            <div className="max-h-96 overflow-auto overscroll-contain">
                <SyntaxSource source={source} language={language} />
            </div>
        </div>
    );
}
