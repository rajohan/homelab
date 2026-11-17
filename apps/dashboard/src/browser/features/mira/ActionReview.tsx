import type { api } from "../../api/client";
import { CodeReview } from "./CodeReview";
import { DaytonaDetails } from "./DaytonaDetails";
import { MailReview } from "./MailReview";
import { PublicationReview } from "./PublicationReview";
import { SocialReview } from "./SocialReview";

export type ActionRequest = Awaited<
    ReturnType<typeof api.mira.proposals.actions.query>
>[number];

/**
 * Reuse the existing exact-content review for each pending Chat action.
 * @returns A review dialog for the selected action.
 */
export function ActionReview({
    action,
    onClose,
}: {
    readonly action: ActionRequest;
    readonly onClose: () => void;
}) {
    switch (action.kind) {
        case "code": {
            return <CodeReview draft={action.draft} onClose={onClose} />;
        }
        case "job": {
            return <DaytonaDetails job={action.draft} onClose={onClose} />;
        }
        case "mail": {
            return <MailReview draft={action.draft} onClose={onClose} />;
        }
        case "publication": {
            return <PublicationReview draft={action.draft} onClose={onClose} />;
        }
        case "social": {
            return <SocialReview draft={action.draft} onClose={onClose} />;
        }
    }
}
