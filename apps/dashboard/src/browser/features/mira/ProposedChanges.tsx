import { Button, ErrorNotice } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ProposalReview } from "./ProposalReview";
import { QuestionReview } from "./QuestionReview";

/**
 * Keep browsable approval and question cards directly above the shared Chat composer.
 * @returns Pending durable requests; changing cards preserves unsent question drafts.
 */
export function ProposedChanges({ conversationId }: { readonly conversationId: string }) {
    const [selected, setSelected] = useState<string>();
    const query = useQuery({
        queryKey: ["operations", "mira", "proposals", conversationId],
        queryFn: () => api.mira.proposals.list.query({ id: conversationId }),
        refetchInterval: 1500,
    });
    const requests = query.data ?? [];
    const index = Math.max(
        0,
        requests.findIndex((request) => request.id === selected)
    );
    if (requests.length === 0 && !query.error) return null;
    return (
        <section
            aria-label="Requests from Mira"
            className="shrink-0 border-t border-primary-700 bg-primary-900/40 px-4 py-3"
        >
            {query.error && <ErrorNotice error={query.error} />}
            {requests.length > 0 && (
                <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <p
                            className="text-sm font-medium text-primary-100"
                            aria-live="polite"
                        >
                            {requests[index]?.tool === "mira_request_user_input"
                                ? "Your input is needed"
                                : "Approval needed"}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="secondary"
                                aria-label="Previous request"
                                disabled={index === 0}
                                onClick={() => setSelected(requests[index - 1]?.id)}
                            >
                                <ChevronLeft size={16} />
                            </Button>
                            <span className="text-xs text-primary-400" aria-live="polite">
                                {index + 1} of {requests.length}
                            </span>
                            <Button
                                variant="secondary"
                                aria-label="Next request"
                                disabled={index === requests.length - 1}
                                onClick={() => setSelected(requests[index + 1]?.id)}
                            >
                                <ChevronRight size={16} />
                            </Button>
                        </div>
                    </div>
                    <div className="max-h-[45dvh] overflow-y-auto overscroll-contain">
                        {requests.map((request, requestIndex) => (
                            <div key={request.id} hidden={requestIndex !== index}>
                                {request.tool === "mira_request_user_input" ? (
                                    <QuestionReview proposal={request} />
                                ) : (
                                    <ProposalReview
                                        proposal={request}
                                        onClose={() => {
                                            void query.refetch();
                                        }}
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                    <p className="mt-2 text-xs text-primary-400">
                        Saved in this conversation until answered or expired (24 hours).
                    </p>
                </>
            )}
        </section>
    );
}
