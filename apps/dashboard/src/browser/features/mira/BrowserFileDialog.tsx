import type {
    MiraBrowserFileRequest,
    miraBrowserHumanCommandSchema,
    MiraBrowserPreview,
} from "@homelab/contracts/miraBrowser";
import { Button, FormField, Modal, Select } from "@homelab/ui";
import { Download, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import type * as v from "valibot";

import { BrowserDownloadControls } from "./BrowserDownloadControls";
import { BrowserUploadControls } from "./BrowserUploadControls";

export type BrowserFileTarget = Pick<
    MiraBrowserFileRequest,
    "origin" | "label" | "observationId" | "ref"
>;
export type BrowserFileCommand = (
    op: v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"]
) => string | undefined;

/** Review one file transfer from the clicked page element or a recent manually selected target.
 * @returns The shared transfer dialog, with a fixed origin and observation until the user selects again.
 */
export function BrowserFileDialog({
    accessId,
    epoch,
    kind,
    request,
    preview,
    now,
    disabled,
    onCommand,
    onClose,
}: {
    readonly accessId: string;
    readonly epoch: string;
    readonly kind: "upload" | "download";
    readonly request: MiraBrowserFileRequest | null;
    readonly preview: MiraBrowserPreview | null;
    readonly now: number;
    readonly disabled: boolean;
    readonly onCommand: BrowserFileCommand;
    readonly onClose: () => void;
}) {
    const upload = kind === "upload";
    const [manual, setManual] = useState(!request);
    const [selected, setSelected] = useState<BrowserFileTarget | null>(null);
    const [submittedOrigin, setSubmittedOrigin] = useState<string | null>(null);
    const clicked = manual ? null : request;
    const target = clicked ?? selected;
    const targets =
        preview?.refs.filter((item) =>
            upload
                ? item.actions.includes("upload")
                : item.role === "link" && item.actions.includes("click")
        ) ?? [];
    const origin = preview && new URL(preview.url).origin;
    const fresh = Boolean(preview && now - Date.parse(preview.observedAt) < 55_000);
    const displayedOrigin = submittedOrigin ?? target?.origin ?? origin;
    const emptyTargets = upload
        ? "No file inputs found on this page."
        : "No download links found on this page.";
    const matches = Boolean(
        target &&
        fresh &&
        target.observationId === preview?.observationId &&
        target.origin === origin &&
        (!clicked || (clicked.kind === kind && Date.parse(clicked.expiresAt) > now)) &&
        targets.some((item) => item.ref === target.ref && item.label === target.label)
    );
    function refresh() {
        if (disabled) return;
        setManual(true);
        setSelected(null);
        onCommand({ method: "observe" });
    }
    return (
        <Modal
            title={upload ? "Upload a file" : "Save a download"}
            {...(displayedOrigin ? { description: displayedOrigin } : {})}
            icon={upload ? Upload : Download}
            onClose={onClose}
        >
            <div className="space-y-4">
                {!submittedOrigin && (
                    <>
                        {clicked && (
                            <p className="text-sm wrap-anywhere text-primary-300">
                                {upload ? "File input" : "Download link"}
                                {clicked.label && ` · ${clicked.label}`}
                            </p>
                        )}
                        {!clicked && fresh && targets.length > 0 && preview && origin && (
                            <FormField
                                label={
                                    upload
                                        ? "File input on the page"
                                        : "Download link on the page"
                                }
                            >
                                <Select
                                    label={
                                        upload
                                            ? "File input on the page"
                                            : "Download link on the page"
                                    }
                                    value={matches && target ? target.ref : ""}
                                    disabled={disabled}
                                    options={[
                                        {
                                            value: "",
                                            label: upload
                                                ? "Choose a file input"
                                                : "Choose a link",
                                        },
                                        ...targets.map((row) => ({
                                            value: row.ref,
                                            label: row.label || row.ref,
                                        })),
                                    ]}
                                    onChange={(ref) => {
                                        const row = targets.find(
                                            (item) => item.ref === ref
                                        );
                                        setSelected(
                                            row
                                                ? {
                                                      ref,
                                                      observationId:
                                                          preview.observationId,
                                                      origin,
                                                      label: row.label,
                                                  }
                                                : null
                                        );
                                    }}
                                />
                            </FormField>
                        )}
                        {(!fresh || (clicked && !matches) || targets.length === 0) && (
                            <div className="space-y-2 text-sm text-primary-400">
                                <p>
                                    {clicked || !fresh
                                        ? "Refresh the page controls to select a current target."
                                        : emptyTargets}
                                </p>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={disabled}
                                    onClick={refresh}
                                >
                                    <RefreshCw size={14} aria-hidden="true" />
                                    Refresh page controls
                                </Button>
                            </div>
                        )}
                    </>
                )}
                {upload ? (
                    <BrowserUploadControls
                        accessId={accessId}
                        epoch={epoch}
                        now={now}
                        target={matches ? target : null}
                        disabled={disabled}
                        onCommand={onCommand}
                        onClose={onClose}
                    />
                ) : (
                    <BrowserDownloadControls
                        target={matches ? target : null}
                        suggestedName={clicked?.suggestedName ?? ""}
                        now={now}
                        disabled={disabled}
                        onCommand={onCommand}
                        onSubmitted={setSubmittedOrigin}
                        onClose={onClose}
                    />
                )}
            </div>
        </Modal>
    );
}
