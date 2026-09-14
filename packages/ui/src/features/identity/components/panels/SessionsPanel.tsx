import { Button, Card } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function SessionsPanel({ data, onAction }: AccountPanelProps) {
    return (
        <Card id="account-sessions" className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">Active sessions</h2>
                <div className="flex flex-wrap gap-2">
                    <Button
                        disabled={data.sessions.length < 2}
                        onClick={() => onAction("others")}
                    >
                        Revoke other sessions
                    </Button>
                    <Button onClick={() => onAction("all")}>Revoke all sessions</Button>
                </div>
            </div>
            <p className="text-base text-slate-600">
                Revoking a session stops its Homelab access. Applications may retain their
                own local sessions until their next authentication check.
            </p>
            <ul className="divide-y divide-slate-200">
                {data.sessions.map((session) => (
                    <li
                        key={session.id}
                        className="flex flex-wrap items-start justify-between gap-3 py-4"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="font-medium">
                                {session.current ? "Current session" : "Browser session"}
                            </p>
                            <p className="mt-1 text-sm wrap-break-word text-slate-600">
                                {session.userAgent}
                            </p>
                            <p className="mt-1 text-sm text-slate-600">
                                Last active{" "}
                                {new Date(session.lastSeenAt).toLocaleString()}
                            </p>
                        </div>
                        <Button
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
        </Card>
    );
}
