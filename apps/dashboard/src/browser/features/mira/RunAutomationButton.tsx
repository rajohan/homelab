import { Button, ErrorNotice } from "@homelab/ui";
import { Play } from "lucide-react";
import { useRef } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Submit one manual automation request with the same identity through uncertain network responses.
 * @returns A full-width run action; a confirmed response permits a later distinct invocation.
 */
export function RunAutomationButton({
    id,
    onStarted,
}: {
    readonly id: string;
    readonly onStarted: (conversationId: string) => void;
}) {
    const requestId = useRef<string | null>(null);
    const run = useOperation(async () => {
        requestId.current ??= crypto.randomUUID();
        const result = await api.mira.automations.run.mutate({
            id,
            requestId: requestId.current,
        });
        requestId.current = null;
        return result;
    });
    return (
        <div className="space-y-3">
            {run.error && <ErrorNotice error={run.error} />}
            <Button
                fullWidth
                busy={run.isPending}
                onClick={() =>
                    void run
                        .mutateAsync(undefined)
                        .then((result) => onStarted(result.conversationId))
                        .catch(() => {})
                }
            >
                <Play size={16} aria-hidden="true" />
                Run now
            </Button>
        </div>
    );
}
