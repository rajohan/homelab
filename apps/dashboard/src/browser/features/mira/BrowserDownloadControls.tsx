import {
    miraBrowserDownloadNameSchema,
    type MiraBrowserPreview,
    type miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Button,
    ConfirmDialog,
    FormField,
    Input,
    Select,
} from "@homelab/ui";
import { Download } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

type Operation = v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"];
type DownloadOperation = Extract<Operation, { method: "download" }>;

/**
 * Confirm a visible download link and its display filename before importing it into this conversation.
 * @returns Shared operator controls bound to the current page observation and approved website.
 */
export function BrowserDownloadControls({
    preview,
    disabled,
    onCommand,
}: {
    readonly preview: MiraBrowserPreview | null;
    readonly disabled: boolean;
    readonly onCommand: (operation: Operation) => void;
}) {
    const [ref, setRef] = useState("");
    const [name, setName] = useState("");
    const [confirmation, setConfirmation] = useState<{
        operation: DownloadOperation;
        label: string;
    } | null>(null);
    const targets =
        preview?.refs.filter(
            (item) => item.role === "link" && item.actions.includes("click")
        ) ?? [];
    const target = targets.find((item) => item.ref === ref);
    const parsedName = v.safeParse(miraBrowserDownloadNameSchema, name);
    const current =
        confirmation &&
        !disabled &&
        preview?.observationId === confirmation.operation.input.observationId &&
        new URL(preview.url).origin === confirmation.operation.origin &&
        targets.some(
            (item) =>
                item.ref === confirmation.operation.input.ref &&
                (item.label || item.ref) === confirmation.label
        );
    return (
        <section
            className="space-y-3 border-t border-primary-700 pt-4"
            aria-label="Download to this conversation"
        >
            <FormField
                label="Download link on the page"
                description="Choose a file link from the current view. Refresh if it is missing."
            >
                <Select
                    value={ref}
                    onChange={setRef}
                    disabled={disabled}
                    options={[
                        { value: "", label: "Choose a download link" },
                        ...targets.map((item) => ({
                            value: item.ref,
                            label: item.label || item.ref,
                        })),
                    ]}
                />
            </FormField>
            <FormField
                label="Save attachment as"
                description="PNG, JPEG, WebP, PDF or UTF-8 text, up to 25 MiB. Use a filename without folders."
            >
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    disabled={disabled}
                    placeholder="document.pdf"
                />
            </FormField>
            <ActionGroup>
                <Button
                    variant="secondary"
                    disabled={disabled || !preview || !target || !parsedName.success}
                    onClick={() => {
                        if (preview && target && parsedName.success)
                            setConfirmation({
                                label: target.label || target.ref,
                                operation: {
                                    method: "download",
                                    name: parsedName.output,
                                    origin: new URL(preview.url).origin,
                                    input: {
                                        observationId: preview.observationId,
                                        ref: target.ref,
                                    },
                                },
                            });
                    }}
                >
                    <Download size={14} aria-hidden="true" />
                    Review download
                </Button>
            </ActionGroup>
            {confirmation && (
                <ConfirmDialog
                    title="Download attachment"
                    description="The file will be saved in this conversation and available to Mira when you return control."
                    confirmLabel="Save to conversation"
                    variant="primary"
                    confirmDisabled={!current}
                    onClose={() => setConfirmation(null)}
                    onConfirm={() => {
                        if (current) {
                            onCommand(confirmation.operation);
                            setConfirmation(null);
                        }
                        return Promise.resolve();
                    }}
                >
                    <dl className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm wrap-anywhere">
                        <div>
                            <dt className="text-primary-400">File</dt>
                            <dd>{confirmation.operation.name}</dd>
                        </div>
                        <div>
                            <dt className="text-primary-400">Link</dt>
                            <dd>{confirmation.label}</dd>
                        </div>
                        <div>
                            <dt className="text-primary-400">Website</dt>
                            <dd>{confirmation.operation.origin}</dd>
                        </div>
                    </dl>
                    {!current && (
                        <p className="text-sm text-primary-400">
                            The view changed. Cancel and refresh before confirming again.
                        </p>
                    )}
                </ConfirmDialog>
            )}
        </section>
    );
}
