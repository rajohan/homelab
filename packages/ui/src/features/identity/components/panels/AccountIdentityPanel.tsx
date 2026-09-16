import { LogOut, UserRound } from "lucide-react";

import { Button, Card, SectionIcon } from "../../../../index";
import type { AccountPanelProps } from "../../types";

/**
 * Identify the signed-in account and offer logout of its current browser session.
 * @param props - The account snapshot and shared confirmation-dialog action handler.
 * @returns A compact account card with logout aligned to its right edge.
 */
export function AccountIdentityPanel({ data, onAction }: AccountPanelProps) {
    const session = data.sessions.find((candidate) => candidate.current);
    return (
        <Card className="flex items-center gap-3 rounded-lg bg-primary-800 p-4 shadow-none sm:p-4">
            <SectionIcon icon={UserRound} />
            <p className="min-w-0 flex-1 text-sm wrap-anywhere text-primary-300">
                Signed in as{" "}
                <strong className="font-semibold text-primary-50">
                    {data.user.username}
                </strong>
                .
            </p>
            <Button
                className="shrink-0"
                size="sm"
                variant="danger"
                disabled={!session}
                onClick={() => {
                    if (session)
                        onAction({
                            kind: "session",
                            current: true,
                            id: session.id,
                            label: "your current session",
                        });
                }}
            >
                <LogOut aria-hidden="true" className="size-4" />
                Log out
            </Button>
        </Card>
    );
}
