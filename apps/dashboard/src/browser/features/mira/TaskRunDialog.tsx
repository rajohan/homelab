import { ConfirmDialog, FormField, Switch, Textarea } from "@homelab/ui";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Capture explicit task execution intent and preserve its identity through a lost response.
 * @returns A shared confirmation dialog with optional instructions and uncertain-outcome review.
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
            reviewedRunId: reviewed ? reviewRunId : null,
        })
    );
    return (
        <ConfirmDialog
            title={`Work on ${title}`}
            description="Mira will use the linked conversation and record progress on this task."
            confirmLabel="Start work"
            variant="primary"
            onClose={onClose}
            confirmDisabled={reviewRunId !== null && !reviewed}
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
            {reviewRunId && (
                <Switch
                    label="I have reviewed the previous uncertain outcome"
                    description="Check the run and any actions it attempted before continuing. They will not be replayed automatically."
                    checked={reviewed}
                    onChange={setReviewed}
                    disabled={submitted}
                />
            )}
        </ConfirmDialog>
    );
}
