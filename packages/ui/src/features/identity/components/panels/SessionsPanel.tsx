import { Monitor } from "lucide-react";

import { Badge, Button, SuccessNotice } from "../../../../index";
import { formatDateTime } from "../../../../lib/formatDateTime";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";
/**
 * List active sessions and offer explicit individual or grouped revocation actions.
 * @returns The component's rendered content for its current state.
 */
export function SessionsPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-sessions"
            title="Active sessions"
            description="Sessions expire after inactivity and can be revoked independently."
            icon={Monitor}
            actions={
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={data.sessions.length < 2}
                        onClick={() => onAction("others")}
                    >
                        Log out others
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => onAction("all")}>
                        Log out all
                    </Button>
                </div>
            }
        >
            <ul className="space-y-2">
                {data.sessions.map((session) => (
                    <li
                        key={session.id}
                        className="flex flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                Browser session{" "}
                                {session.current && (
                                    <Badge tone="positive">Current</Badge>
                                )}
                            </p>
                            <p className="mt-1 text-xs wrap-anywhere text-primary-300">
                                {session.userAgent}
                            </p>
                            <p className="mt-1 text-xs text-primary-400">
                                Last active {formatDateTime(session.lastSeenAt)}
                            </p>
                        </div>
                        <Button
                            size="sm"
                            variant={session.current ? "danger" : "secondary"}
                            onClick={() =>
                                onAction({
                                    kind: "session",
                                    current: session.current,
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
        </SettingsSection>
    );
}
