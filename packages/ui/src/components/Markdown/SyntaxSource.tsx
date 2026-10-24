import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import css from "react-syntax-highlighter/dist/esm/languages/hljs/css";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import xml from "react-syntax-highlighter/dist/esm/languages/hljs/xml";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/light";
import monokaiSublime from "react-syntax-highlighter/dist/esm/styles/hljs/monokai-sublime";

function languageDefinition(value: unknown): (...args: unknown[]) => unknown {
    if (typeof value !== "function") throw new TypeError("Invalid syntax grammar");
    return value as (...args: unknown[]) => unknown;
}
const codeTagProps: SyntaxHighlighterProps["codeTagProps"] = {
    style: { fontFamily: "inherit" },
};
const languages: Readonly<Record<string, unknown>> = {
    css,
    dockerfile,
    html: xml,
    javascript,
    json,
    markdown,
    python,
    shell: bash,
    sql,
    typescript,
    xml,
    yaml,
};
const aliases: Readonly<Record<string, string>> = {
    bash: "shell",
    sh: "shell",
    zsh: "shell",
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    md: "markdown",
    yml: "yaml",
};
for (const [name, definition] of Object.entries(languages))
    SyntaxHighlighter.registerLanguage(name, languageDefinition(definition));

/**
 * Render bounded source with the legacy dashboard's language registry and Monokai palette.
 * @returns Safe React syntax tokens, or readable plain text for unsupported and large blocks.
 */
export function SyntaxSource({
    source,
    language,
}: {
    readonly source: string;
    readonly language: string;
}) {
    const grammar = aliases[language] ?? language;
    const supported = Object.hasOwn(languages, grammar) && source.length <= 32_000;
    return supported ? (
        <SyntaxHighlighter
            language={grammar}
            style={monokaiSublime}
            customStyle={{
                margin: 0,
                padding: "1rem",
                background: "transparent",
                fontSize: "0.8125rem",
                lineHeight: 1.7,
            }}
            codeTagProps={codeTagProps}
            wrapLongLines={false}
        >
            {source}
        </SyntaxHighlighter>
    ) : (
        <pre className="m-0 overflow-x-auto p-4 font-mono text-[0.8125rem] leading-relaxed text-primary-100">
            <code>{source}</code>
        </pre>
    );
}
