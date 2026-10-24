import {
    Button,
    ErrorNotice,
    ConfirmDialog,
    FormField,
    Switch,
    Textarea,
} from "@homelab/ui";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraRunDetails } from "./MiraRunDetails";

/**
 * Capture explicit task execution intent and preserve its identity through a lost response.
 * @returns Shared run inspection for recovery, or an explicit new-work confirmation.
 */
export function TaskRunDialog({
    id,
    title,
    version,
    reviewRunId,
    onClose,
    onStarted,
}: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly reviewRunId: string | null;
    readonly onClose: () => void;
    readonly onStarted: (conversationId: string) => void;
}) {
    const [instructions, setInstructions] = useState("");
    const [reviewed, setReviewed] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const requestId = useRef(crypto.randomUUID());
    const run = useOperation(() =>
        api.mira.tasks.run.mutate({
            id,
            version,
            requestId: requestId.current,
            instructions,
            reviewedRunId: null,
        })
    );
    const review = useOperation(
        () => api.mira.tasks.reviewRun.mutate({ id, version, runId: reviewRunId! }),
        onClose
    );
    if (reviewRunId)
        return (
            <MiraRunDetails
                id={reviewRunId}
                onClose={onClose}
                footer={
                    <div className="space-y-3 border-t border-primary-700 pt-4">
                        <Switch
                            label="I have reviewed this uncertain outcome"
                            description="Check its attempted actions. Each uncertain run must be reviewed before any further task work can start."
                            checked={reviewed}
                            onChange={setReviewed}
                            disabled={review.isPending}
                        />
                        {review.error && <ErrorNotice error={review.error} />}
                        <Button
                            fullWidth
                            disabled={!reviewed}
                            busy={review.isPending}
                            onClick={() => review.mutate(undefined)}
                        >
                            Mark reviewed
                        </Button>
                    </div>
                }
            />
        );
    return (
        <ConfirmDialog
            title={`Work on ${title}`}
            description="Mira will use the linked conversation and record progress on this task."
            confirmLabel="Start work"
            variant="primary"
            onClose={onClose}
            onConfirm={async () => {
                setSubmitted(true);
                const result = await run.mutateAsync(undefined);
                onStarted(result.conversationId);
            }}
        >
            <FormField
                label="Additional instructions"
                description="Optional scope or priority for this run."
            >
                <Textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    maxLength={4000}
                    disabled={submitted}
                />
            </FormField>
        </ConfirmDialog>
    );
}
