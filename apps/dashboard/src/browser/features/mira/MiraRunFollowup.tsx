import type { MiraRun, MiraRunResolution } from "@homelab/contracts/mira";
import {
    ActionGroup,
    Badge,
    Button,
    ErrorNotice,
    formatDateTime,
    FormField,
    SectionHeader,
    Select,
    Textarea,
} from "@homelab/ui";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Record an operator's follow-up decision while preserving the original execution outcome.
 * @param props - Owned run and whether all terminal outcomes have been loaded.
 * @returns Shared closure controls and the durable reason in Chat and Jobs.
 */
export function MiraRunFollowup({
    run,
    eligible,
}: {
    readonly run: Pick<MiraRun, "id" | "followupResolution">;
    readonly eligible: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [outcome, setOutcome] = useState<MiraRunResolution["outcome"]>("dismissed");
    const [reason, setReason] = useState("");
    const operation = useOperation(
        (
            input: { id: string; outcome: MiraRunResolution["outcome"]; reason: string },
            signal
        ) => api.mira.runs.resolve.mutate(input, { signal })
    );
    const resolution = run.followupResolution ?? operation.data;
    if (resolution)
        return (
            <div className="space-y-3 rounded-lg border border-primary-700 bg-surface-card p-4">
                <SectionHeader
                    title="Follow-up closed"
                    icon={ClipboardCheck}
                    badge={
                        <Badge tone="info">
                            {resolution.outcome === "dismissed"
                                ? "No longer relevant"
                                : "Reviewed"}
                        </Badge>
                    }
                    description={formatDateTime(resolution.closedAt)}
                />
                <p className="text-sm wrap-anywhere whitespace-pre-wrap text-primary-300">
                    {resolution.reason}
                </p>
                <p className="text-xs text-primary-400">
                    Recorded execution outcomes are unchanged. This decision does not
                    restart work.
                </p>
            </div>
        );
    if (!eligible) return null;
    if (!editing)
        return (
            <ActionGroup stretch={false}>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                    Close follow-up
                </Button>
            </ActionGroup>
        );
    return (
        <form
            className="space-y-4 rounded-lg border border-primary-700 bg-surface-card p-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (reason.trim().length < 4 || operation.isPending) return;
                void operation
                    .mutateAsync({ id: run.id, outcome, reason: reason.trim() })
                    .catch(() => {});
            }}
        >
            <SectionHeader
                title="Close follow-up"
                icon={ClipboardCheck}
                description="Stop carrying this run forward as an open item in reports. Recorded outcomes stay unchanged and no work restarts."
            />
            <FormField label="Decision">
                <Select
                    label="Decision"
                    value={outcome}
                    onChange={setOutcome}
                    disabled={operation.isPending}
                    options={[
                        { value: "dismissed", label: "No longer relevant" },
                        { value: "reviewed", label: "Reviewed" },
                    ]}
                />
            </FormField>
            <FormField
                label="Reason"
                description="Explain why follow-up is complete or no longer needed."
            >
                <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    minLength={4}
                    maxLength={2000}
                    rows={3}
                    disabled={operation.isPending}
                />
            </FormField>
            {operation.isError && <ErrorNotice error={operation.error} />}
            <ActionGroup>
                <Button
                    type="button"
                    variant="secondary"
                    disabled={operation.isPending}
                    onClick={() => setEditing(false)}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    busy={operation.isPending}
                    disabled={reason.trim().length < 4}
                >
                    Save decision
                </Button>
            </ActionGroup>
        </form>
    );
}
