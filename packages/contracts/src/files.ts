export interface FilePresentation {
    readonly kind: "image" | "pdf" | "markdown" | "json" | "code" | "table" | "text";
    readonly label: string;
    readonly language: string;
}
const languages: Readonly<Record<string, readonly [string, string]>> = {
    js: ["JavaScript", "javascript"],
    jsx: ["JavaScript", "javascript"],
    ts: ["TypeScript", "typescript"],
    tsx: ["TypeScript", "typescript"],
    mjs: ["JavaScript", "javascript"],
    cjs: ["JavaScript", "javascript"],
    py: ["Python", "python"],
    sh: ["Shell", "shell"],
    bash: ["Shell", "shell"],
    ps1: ["PowerShell", "powershell"],
    sql: ["SQL", "sql"],
    css: ["CSS", "css"],
    html: ["HTML", "html"],
    htm: ["HTML", "html"],
    xml: ["XML", "xml"],
    svg: ["SVG", "xml"],
    yaml: ["YAML", "yaml"],
    yml: ["YAML", "yaml"],
    toml: ["TOML", "ini"],
    ini: ["INI", "ini"],
    rs: ["Rust", "rust"],
    go: ["Go", "go"],
    cs: ["C#", "csharp"],
    diff: ["Diff", "diff"],
    patch: ["Patch", "diff"],
};

/**
 * Describe a file consistently without treating its extension as permission to execute it.
 * @param file - Display name and optional byte-verified media type.
 * @returns Human label, icon category and an explicit syntax grammar.
 */
export function describeFile(file: {
    name: string;
    mediaType?: string;
}): FilePresentation {
    const name = file.name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
    const extension = name.split(".").at(-1) ?? "";
    const media = file.mediaType?.split(";")[0]?.trim().toLowerCase();
    if (media?.startsWith("image/") && media !== "image/svg+xml")
        return { kind: "image", label: "Image", language: "text" };
    if (media === "application/pdf")
        return { kind: "pdf", label: "PDF", language: "text" };
    if (["md", "markdown", "mdown"].includes(extension) || media === "text/markdown")
        return { kind: "markdown", label: "Markdown", language: "markdown" };
    if (extension === "json" || media === "application/json" || media?.endsWith("+json"))
        return { kind: "json", label: "JSON", language: "json" };
    if (["jsonl", "ndjson"].includes(extension))
        return { kind: "code", label: "JSON Lines", language: "json" };
    if (["csv", "tsv"].includes(extension))
        return { kind: "table", label: extension.toUpperCase(), language: "text" };
    if (name === "dockerfile" || name.startsWith("dockerfile."))
        return { kind: "code", label: "Dockerfile", language: "dockerfile" };
    if (name === ".env" || name.startsWith(".env."))
        return { kind: "code", label: "Environment", language: "ini" };
    const definition = languages[extension];
    if (definition)
        return { kind: "code", label: definition[0], language: definition[1] };
    return { kind: "text", label: "Text", language: "text" };
}
