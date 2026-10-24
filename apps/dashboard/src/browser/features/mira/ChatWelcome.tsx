import { Card } from "@homelab/ui";
import { MessageSquare } from "lucide-react";

import { NewConversationButton } from "./NewConversationButton";

/**
 * Center the empty chat workspace around its next available action.
 * @returns A compact welcome state; mobile uses the conversation list directly.
 */
export function ChatWelcome() {
    return (
        <Card className="hidden min-h-0 items-center justify-center lg:flex">
            <div className="flex max-w-sm flex-col items-center gap-5 px-6 py-10 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-accent-900/30 text-accent-300">
                    <MessageSquare size={28} aria-hidden="true" />
                </div>
                <div className="space-y-2">
                    <h2 className="text-xl font-semibold text-primary-50">
                        Talk to Mira
                    </h2>
                    <p className="text-sm leading-6 text-primary-400">
                        Start a conversation or pick one from your history.
                    </p>
                </div>
                <NewConversationButton />
            </div>
        </Card>
    );
}
