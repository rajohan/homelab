import { Button } from "@homelab/ui";
import { useSyncExternalStore } from "react";

import type { MiraVoiceConnection } from "./voiceConnection";

/** Show only current transcription, unsent text or an actionable audio error.
 * @returns Transient feedback inside the composer, with no idle status row.
 */
export function VoiceStatus({ voice }: { readonly voice: MiraVoiceConnection }) {
    const state = useSyncExternalStore(voice.subscribe, voice.snapshot);
    if (!state.transcript && !state.error && state.pending === 0) return null;
    return (
        <div className="mb-2 space-y-2">
            {state.transcript && (
                <p
                    className="text-sm wrap-anywhere text-primary-200"
                    aria-label="Voice transcript"
                    aria-live="polite"
                >
                    {state.transcript}
                </p>
            )}
            {state.error && (
                <p role="alert" className="text-sm text-red-300">
                    {state.error}
                </p>
            )}
            {(state.error || state.pending > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => voice.retry()}>
                        Retry voice
                    </Button>
                    {state.pending > 0 && (
                        <>
                            <span className="text-xs text-primary-300">
                                {state.pending} transcript(s) waiting to send
                            </span>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => voice.discardPending()}
                            >
                                Discard unsent
                            </Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
