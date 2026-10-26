import { Badge, CopyTextButton, SyntaxSource } from "@homelab/ui";

function fileStatus(file: { content: string | null; beforeSha256: string | null }) {
    if (file.content === null) return "Delete";
    return file.beforeSha256 === null ? "New file" : "Replace";
}

/**
 * Render complete tested replacements without interpreting source as HTML or Markdown.
 * @returns Bounded themed code surfaces with explicit file operations.
 */
export function CodeFiles({
    files,
}: {
    readonly files: readonly {
        path: string;
        beforeSha256: string | null;
        content: string | null;
    }[];
}) {
    return (
        <div className="space-y-3">
            {files.map((file) => (
                <section
                    key={file.path}
                    aria-label={`Changes to ${file.path}`}
                    className="min-w-0 overflow-hidden rounded-lg border border-primary-700 bg-primary-950"
                >
                    <div className="flex flex-wrap items-center gap-2 border-b border-primary-700 bg-primary-900/60 px-3 py-2">
                        <p className="w-full min-w-0 font-mono text-xs wrap-anywhere text-primary-200 sm:w-auto sm:flex-1">
                            {file.path}
                        </p>
                        <Badge tone={file.content === null ? "warning" : "neutral"}>
                            {fileStatus(file)}
                        </Badge>
                        {file.content !== null && (
                            <CopyTextButton
                                text={file.content}
                                label={`Copy ${file.path}`}
                                iconOnly
                            />
                        )}
                    </div>
                    {file.content === null ? (
                        <p className="p-4 text-sm text-primary-300">
                            This file will be deleted.
                        </p>
                    ) : (
                        <div className="max-h-96 overflow-auto overscroll-contain">
                            <SyntaxSource
                                source={file.content}
                                language={
                                    file.path.split(".").at(-1)?.toLowerCase() ?? "text"
                                }
                            />
                        </div>
                    )}
                </section>
            ))}
        </div>
    );
}
