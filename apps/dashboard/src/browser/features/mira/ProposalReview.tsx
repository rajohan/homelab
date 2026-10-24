import type { MiraProposal } from "@homelab/contracts/mira";
import { ActionGroup, Button, ErrorNotice, Modal } from "@homelab/ui";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

const actions: Record<string, string> = {
    mira_task_create: "create a task",
    mira_task_update: "update a task",
    mira_task_progress: "record task progress",
    mira_memory_create: "save a memory",
};

const labels: Record<string, string> = {
    id: "Task reference",
    taskId: "Task reference",
    title: "Title",
    description: "Description",
    status: "Status",
    assignee: "Assigned to",
    priority: "Priority",
    labels: "Labels",
    dueAt: "Due",
    completionCriteria: "Completion criteria",
    conversationId: "Linked conversation",
    version: "Expected version",
    text: "Progress",
    content: "Memory",
};

function displayValue(value: unknown): string {
    if (value === null || value === "") return "None";
    if (typeof value === "string") return value;
    if (Array.isArray(value))
        return value.length > 0
            ? value.map((entry) => displayValue(entry)).join(", ")
            : "None";
    return JSON.stringify(value) ?? "None";
}

/**
 * Show every immutable proposed field before an explicit human decision.
 * @returns A bounded review dialog whose retry keeps the same receipt and argument hash.
 */
export function ProposalReview({
    proposal,
    onClose,
}: {
    readonly proposal: MiraProposal;
    readonly onClose: () => void;
}) {
    const decide = useOperation((approve: boolean) =>
        api.mira.proposals.decide.mutate({
            id: proposal.id,
            inputHash: proposal.inputHash,
            approve,
        })
    );
    const submit = async (approve: boolean) => {
        await decide.mutateAsync(approve);
        onClose();
    };
    return (
        <Modal title="Review proposed change" size="wide" onClose={onClose}>
            <div className="space-y-4">
                <p className="text-sm text-primary-300">
                    Mira proposes to {actions[proposal.tool] ?? "apply a product change"}.
                    Review all fields below. Approving applies this exact change once.
                </p>
                <dl className="divide-y divide-primary-700 rounded-lg border border-primary-700 bg-primary-900/40">
                    {Object.entries(proposal.input).map(([key, value]) => (
                        <div key={key} className="space-y-1 p-3">
                            <dt className="text-xs font-medium text-primary-400">
                                {labels[key] ?? key}
                            </dt>
                            <dd className="text-sm wrap-anywhere whitespace-pre-wrap text-primary-100">
                                {displayValue(value)}
                            </dd>
                        </div>
                    ))}
                </dl>
                {decide.error && <ErrorNotice error={decide.error} />}
                <ActionGroup>
                    <Button
                        busy={decide.isPending}
                        onClick={() => void submit(true).catch(() => {})}
                    >
                        Approve change
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={decide.isPending}
                        onClick={() => void submit(false).catch(() => {})}
                    >
                        Reject
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={decide.isPending}
                        onClick={onClose}
                    >
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
