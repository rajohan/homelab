import type { MiraProposal } from "@homelab/contracts/mira";
import { Badge, Button, Card, ErrorNotice, Modal, SectionHeader } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ProposalReview } from "./ProposalReview";

/**
 * Keep pending human decisions visible across run completion and conversation reconnects.
 * @returns A compact review entry point and shared dialogs, or nothing when no decision is pending.
 */
export function ProposedChanges({ conversationId }: { readonly conversationId: string }) {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<MiraProposal>();
    const query = useQuery({
        queryKey: ["operations", "mira", "proposals", conversationId],
        queryFn: () => api.mira.proposals.list.query({ id: conversationId }),
        refetchInterval: 5000,
    });
    if (selected)
        return (
            <ProposalReview proposal={selected} onClose={() => setSelected(undefined)} />
        );
    if (!query.data?.length && !query.error) return null;
    return (
        <>
            <div className="shrink-0 border-b border-primary-700 px-4 py-3">
                {query.error ? (
                    <ErrorNotice error={query.error} />
                ) : (
                    <SectionHeader
                        title="Proposed changes"
                        icon={ShieldCheck}
                        badge={<Badge>{query.data?.length}</Badge>}
                        compactActions
                        actions={
                            <Button variant="secondary" onClick={() => setOpen(true)}>
                                Review
                            </Button>
                        }
                    />
                )}
            </div>
            {open && (
                <Modal title="Proposed changes" onClose={() => setOpen(false)}>
                    <div className="space-y-3">
                        <p className="text-sm text-primary-400">
                            These changes await your approval and expire after 24 hours.
                        </p>
                        {query.data?.map((proposal) => (
                            <Card key={proposal.id} className="bg-primary-900/40">
                                <SectionHeader
                                    title={
                                        typeof proposal.input.title === "string"
                                            ? proposal.input.title
                                            : proposal.tool
                                                  .replace(/^mira_/, "")
                                                  .replaceAll("_", " ")
                                    }
                                    icon={ShieldCheck}
                                    compactActions
                                    actions={
                                        <Button
                                            variant="secondary"
                                            onClick={() => setSelected(proposal)}
                                        >
                                            Review change
                                        </Button>
                                    }
                                />
                            </Card>
                        ))}
                    </div>
                </Modal>
            )}
        </>
    );
}
