import { Button } from "@homelab/ui";

import type { MiraVoiceConnection } from "./voiceConnection";

/** Show audio recovery controls alongside the conversation's connection notices.
 * @param props - The live transport and the pending count or actionable error from its subscription.
 * @returns A notice while a recording or its delivery needs attention.
 */
export function VoiceStatus({
    voice,
    error,
    pending,
}: {
    readonly voice: MiraVoiceConnection;
    readonly error: string;
    readonly pending: number;
}) {
    if (!error && pending === 0) return null;
    return (
        <div className="mx-3 my-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary-700 bg-surface-card px-3 py-2">
            {error && (
                <p role="alert" className="text-sm text-red-300">
                    {error}
                </p>
            )}
            {pending > 0 && (
                <span className="text-sm text-primary-300">
                    {pending} {pending === 1 ? "transcript" : "transcripts"} waiting to
                    send
                </span>
            )}
            <Button size="sm" variant="secondary" onClick={() => voice.retry()}>
                Retry voice
            </Button>
            {pending > 0 && (
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => voice.discardPending()}
                >
                    Discard unsent
                </Button>
            )}
        </div>
    );
}
