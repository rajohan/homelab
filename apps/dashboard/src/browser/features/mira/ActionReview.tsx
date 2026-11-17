import { ErrorNotice, LoadingState, Modal } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { CodeReview } from "./CodeReview";
import { DaytonaDetails } from "./DaytonaDetails";
import { MailReview } from "./MailReview";
import { PublicationReview } from "./PublicationReview";
import { SocialReview } from "./SocialReview";

export type ActionRequest = Awaited<
    ReturnType<typeof api.mira.proposals.actions.query>
>["rows"][number];

/**
 * Reuse the existing exact-content review for each Chat action and its durable outcome.
 * @returns A review dialog for the selected action.
 */
export function ActionReview({
    action,
    onClose,
}: {
    readonly action: ActionRequest;
    readonly onClose: () => void;
}) {
    const current = useQuery({
        queryKey: ["operations", "mira", "action", action.kind, action.id],
        queryFn: () =>
            api.mira.proposals.action.query({ kind: action.kind, id: action.id }),
        refetchInterval: action.pending ? 5000 : false,
    });
    const details = current.data;
    if (!details)
        return (
            <Modal title="Action details" onClose={onClose}>
                {current.error ? (
                    <ErrorNotice error={current.error} />
                ) : (
                    <LoadingState label="Loading action…" />
                )}
            </Modal>
        );
    switch (details.kind) {
        case "code": {
            return <CodeReview draft={details.draft} onClose={onClose} />;
        }
        case "job": {
            return <DaytonaDetails job={details.draft} onClose={onClose} />;
        }
        case "mail": {
            return <MailReview draft={details.draft} onClose={onClose} />;
        }
        case "publication": {
            return <PublicationReview draft={details.draft} onClose={onClose} />;
        }
        case "social": {
            return <SocialReview draft={details.draft} onClose={onClose} />;
        }
    }
}
