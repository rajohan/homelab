import { Monitor } from "lucide-react";

import { Button, Card, SectionHeader, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
/**
 * List active sessions and offer explicit individual or grouped revocation actions.
 * @returns The component's rendered content for its current state.
 */
export function SessionsPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <Card id="account-sessions" className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionHeader title="Active sessions" icon={Monitor} />
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="secondary"
                        disabled={data.sessions.length < 2}
                        onClick={() => onAction("others")}
                    >
                        Revoke other sessions
                    </Button>
                    <Button variant="secondary" onClick={() => onAction("all")}>
                        Revoke all sessions
                    </Button>
                </div>
            </div>
            <p className="text-sm leading-6 text-primary-400">
                Revoking a session stops its Homelab access. Applications may retain their
                own local sessions until their next authentication check.
            </p>
            <ul className="divide-y divide-primary-700">
                {data.sessions.map((session) => (
                    <li
                        key={session.id}
                        className="flex flex-wrap items-start justify-between gap-3 py-4"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="font-medium">
                                {session.current ? "Current session" : "Browser session"}
                            </p>
                            <p className="mt-1 text-sm wrap-break-word text-primary-300">
                                {session.userAgent}
                            </p>
                            <p className="mt-1 text-sm text-primary-300">
                                Last active{" "}
                                {new Date(session.lastSeenAt).toLocaleString()}
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            onClick={() =>
                                onAction({
                                    kind: "session",
                                    id: session.id,
                                    label: session.current
                                        ? "your current session"
                                        : "this session",
                                })
                            }
                        >
                            {session.current ? "Log out" : "Revoke"}
                        </Button>
                    </li>
                ))}
            </ul>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </Card>
    );
}
