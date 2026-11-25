import { Button } from "@homelab/ui";
import { KeyRound } from "lucide-react";

import type { ChatgptConnectionState } from "./useChatgptConnection";

/** Keep an interrupted sign-in reachable without exposing its code in the conversation.
 * @returns A compact notice only while the account needs attention.
 */
export function ChatConnectionNotice({
    auth,
    onSignIn,
}: {
    readonly auth: ChatgptConnectionState;
    readonly onSignIn: () => void;
}) {
    if (!auth.showNotice) return null;
    return (
        <div className="mx-3 my-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary-700 bg-surface-card px-3 py-2">
            <KeyRound size={16} aria-hidden="true" className="shrink-0 text-amber-300" />
            <div className="min-w-36 flex-1 text-sm">
                <p className="font-medium text-primary-100">ChatGPT · {auth.label}</p>
                {!auth.canOpen && <p className="text-primary-300">{auth.description}</p>}
            </div>
            {auth.canOpen && (
                <Button size="sm" variant="secondary" onClick={onSignIn}>
                    {auth.action}
                </Button>
            )}
        </div>
    );
}
