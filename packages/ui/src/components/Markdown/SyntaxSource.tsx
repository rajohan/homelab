import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import csharp from "react-syntax-highlighter/dist/esm/languages/hljs/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/hljs/css";
import diff from "react-syntax-highlighter/dist/esm/languages/hljs/diff";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import go from "react-syntax-highlighter/dist/esm/languages/hljs/go";
import ini from "react-syntax-highlighter/dist/esm/languages/hljs/ini";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import powershell from "react-syntax-highlighter/dist/esm/languages/hljs/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import rust from "react-syntax-highlighter/dist/esm/languages/hljs/rust";
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
    csharp,
    diff,
    go,
    ini,
    powershell,
    rust,
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
    toml: "ini",
    ps1: "powershell",
    rs: "rust",
    cs: "csharp",
    patch: "diff",
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
