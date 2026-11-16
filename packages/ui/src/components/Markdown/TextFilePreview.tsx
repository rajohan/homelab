import { describeFile, formatJsonPreview } from "@homelab/contracts/files";
import { useState } from "react";

import { Button } from "../Button/Button";
import { CopyTextButton } from "../Button/CopyTextButton";
import { Markdown } from "./Markdown";
import { SyntaxSource } from "./SyntaxSource";

function previewText(text: string, json: boolean): string {
    if (!json) return text;
    try {
        return formatJsonPreview(text);
    } catch {
        return text;
    }
}

/**
 * Render passive file text using the same Markdown and syntax components as Chat.
 * @returns A bounded formatted preview, source toggle for Markdown and explicit copy action.
 */
export function TextFilePreview({
    name,
    mediaType,
    text,
    truncated = false,
}: {
    readonly name: string;
    readonly mediaType: string;
    readonly text: string;
    readonly truncated?: boolean;
}) {
    const [source, setSource] = useState(false);
    const presentation = describeFile({ name, mediaType });
    const formatted = previewText(text, presentation.kind === "json");
    const content = formatted.slice(0, 32_000);
    const shortened = truncated || content.length < formatted.length;
    if (!content)
        return (
            <p className="text-sm text-primary-400">
                No readable text was found in this file.
            </p>
        );
    return (
        <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-primary-400">
                    {presentation.kind === "pdf" ? "PDF text" : presentation.label}
                </span>
                <div className="flex items-center gap-2">
                    {presentation.kind === "markdown" && (
                        <>
                            <Button
                                size="sm"
                                variant="secondary"
                                aria-pressed={!source}
                                onClick={() => setSource(false)}
                            >
                                Preview
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                aria-pressed={source}
                                onClick={() => setSource(true)}
                            >
                                Source
                            </Button>
                        </>
                    )}
                    <CopyTextButton text={content} label="Copy preview" iconOnly />
                </div>
            </div>
            <div className="max-h-[60dvh] min-w-0 overflow-auto overscroll-contain rounded-lg border border-primary-700 bg-primary-950/30">
                {presentation.kind === "markdown" && !source ? (
                    <div className="p-4">
                        <Markdown>{content}</Markdown>
                    </div>
                ) : (
                    <SyntaxSource source={content} language={presentation.language} />
                )}
            </div>
            {shortened && (
                <p className="text-sm text-primary-400">
                    This preview is shortened. Download the original for the complete
                    file.
                </p>
            )}
        </div>
    );
}
