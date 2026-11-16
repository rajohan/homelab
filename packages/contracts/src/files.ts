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

const mediaExtensions: Readonly<Record<string, string>> = {
    "text/javascript": "js",
    "application/javascript": "js",
    "text/typescript": "ts",
    "text/html": "html",
    "text/css": "css",
    "text/xml": "xml",
    "application/xml": "xml",
    "text/yaml": "yaml",
    "application/yaml": "yaml",
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
    if (media === "image/svg+xml") return { kind: "code", label: "SVG", language: "xml" };
    if (media === "application/json" || media?.endsWith("+json"))
        return { kind: "json", label: "JSON", language: "json" };
    if (media === "text/markdown")
        return { kind: "markdown", label: "Markdown", language: "markdown" };
    const mediaExtension = media ? mediaExtensions[media] : undefined;
    const mediaLanguage = mediaExtension ? languages[mediaExtension] : undefined;
    if (mediaLanguage)
        return { kind: "code", label: mediaLanguage[0], language: mediaLanguage[1] };
    if (media === "text/csv") return { kind: "table", label: "CSV", language: "text" };
    if (["md", "markdown", "mdown"].includes(extension))
        return { kind: "markdown", label: "Markdown", language: "markdown" };
    if (extension === "json") return { kind: "json", label: "JSON", language: "json" };
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

/**
 * Add bounded JSON whitespace without changing numeric or string token spelling.
 * @param source - Complete original JSON; malformed JSON throws for a raw-text fallback.
 * @returns At most 64,001 characters, including one extra character to signal truncation.
 */
export function formatJsonPreview(source: string): string {
    if (source.length > 1_048_576) return source.slice(0, 64_001);
    // Validation only: serializing this parsed value would round large numbers and erase -0.
    JSON.parse(source);
    let result = "";
    let depth = 0;
    let previous = "";
    const indent = () => "  ".repeat(Math.min(depth, 16));
    for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)) {
        const token = match[0];
        let whitespace = "";
        if (token === "}" || token === "]") {
            depth--;
            if (previous !== "{" && previous !== "[") whitespace = "\n" + indent();
        } else if (previous === "{" || previous === "[") {
            whitespace = "\n" + indent();
        }
        result += whitespace;
        if (token === ",") result += ",\n" + indent();
        else if (token === ":") result += ": ";
        else {
            result += token;
            if (token === "{" || token === "[") depth++;
        }
        if (result.length > 64_000) return result.slice(0, 64_001);
        previous = token;
    }
    return result;
}
