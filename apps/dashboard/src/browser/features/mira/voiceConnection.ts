import type { MiraMessage } from "@homelab/contracts/mira";
import { type MiraVoiceName, miraVoiceNames } from "@homelab/contracts/miraVoice";
import * as v from "valibot";

import { api } from "../../api/client";

const responseMetadata = v.object({ speechId: v.optional(v.string()) });
const turnDetection = v.object({
    create_response: v.boolean(),
    interrupt_response: v.boolean(),
});
const inputConfiguration = v.object({
    turn_detection: turnDetection,
    transcription: v.nullable(v.object({ model: v.string() })),
});
const sessionConfiguration = v.object({
    audio: v.object({ input: inputConfiguration }),
    tools: v.array(v.unknown()),
});
const eventSchema = v.object({
    type: v.string(),
    session: v.optional(sessionConfiguration),
    item_id: v.optional(v.string()),
    transcript: v.optional(v.string()),
    delta: v.optional(v.string()),
    response_id: v.optional(v.string()),
    response: v.optional(
        v.object({
            id: v.string(),
            status: v.optional(v.string()),
            metadata: v.optional(v.nullable(responseMetadata)),
        })
    ),
});
const outboxSchema = v.array(v.object({ id: v.string(), text: v.string() }));
type Utterance = { id: string; text: string | null; discarded: boolean };

/** Browser-owned audio transport; ordinary Mira messages retain all task authority. */
export class MiraVoiceConnection {
    private conversationId: string;
    private changed: () => void;
    private listeners = new Set<() => void>();
    private value = {
        microphone: false,
        paused: false,
        speech: false,
        speaking: false,
        readingId: null as string | null,
        connection: "off",
        transcript: "",
        error: "",
        pending: 0,
        model: "gpt-realtime-2.1-mini",
        voice: "marin" as MiraVoiceName,
    };
    private pc: RTCPeerConnection | undefined;
    private channel: RTCDataChannel | undefined;
    private sender: RTCRtpSender | undefined;
    private stream: MediaStream | undefined;
    private audio = new Audio();
    private generation = 0;
    private sessionReady = false;
    private captureGeneration = 0;
    private destroyed = false;
    private attempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private renewalTimer: ReturnType<typeof setTimeout> | undefined;
    private connectionTimer: ReturnType<typeof setTimeout> | undefined;
    private sendTimer: ReturnType<typeof setTimeout> | undefined;
    private responseId: string | undefined;
    private responseDone = false;
    private playbackDone = false;
    private utterances = new Map<string, Utterance>();
    private spoken = new Set<string>();
    private initialized = false;
    private speechQueue: { id: string; text: string }[] = [];
    private reading = false;
    private outbox: { id: string; text: string }[] = [];
    private sending = false;

    /** Bind audio and retry identities to exactly one conversation.
     * @param conversationId - Owned conversation; switching conversations destroys this transport.
     * @param changed - Refresh visible text after ordinary message admission.
     */
    constructor(conversationId: string, changed: () => void) {
        this.conversationId = conversationId;
        this.changed = changed;
        this.audio.autoplay = true;
        this.audio.muted = true;
        try {
            const model = localStorage.getItem(`mira.voice.model:${conversationId}`);
            if (model) this.value.model = model;
            const savedVoice = localStorage.getItem(`mira.voice.name:${conversationId}`);
            if (miraVoiceNames.some((name) => name === savedVoice))
                this.value.voice = savedVoice as MiraVoiceName;
            this.outbox = v.parse(
                outboxSchema,
                JSON.parse(sessionStorage.getItem(this.outboxKey()) ?? "[]")
            );
            this.value.pending = this.outbox.length;
        } catch {
            /* Storage is optional; the live connection keeps its retry identities. */
        }
    }

    /** Subscribe React to audio state, without storing devices or credentials in React.
     * @param listener - Called after a state transition.
     * @returns Subscription cleanup.
     */
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    /** Read the immutable current state.
     * @returns Microphone, playback and connection status.
     */
    snapshot = () => this.value;
    private update(change: Partial<typeof this.value>) {
        if (this.destroyed) return;
        this.value = { ...this.value, ...change };
        for (const listener of this.listeners) listener();
    }
    private outboxKey() {
        return `mira.voice.pending:${this.conversationId}`;
    }
    private persist() {
        try {
            sessionStorage.setItem(this.outboxKey(), JSON.stringify(this.outbox));
        } catch {
            /* Retry stays in memory. */
        }
        this.update({ pending: this.outbox.length });
    }
    private emit(event: object) {
        if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
    }

    /** Enable or release the microphone independently of spoken replies.
     * @param enabled - False stops every captured microphone track immediately.
     * @returns Completion of the browser permission/capture operation.
     */
    async microphone(enabled: boolean) {
        const capture = ++this.captureGeneration;
        this.update({ microphone: enabled, paused: false, error: "" });
        if (!enabled) {
            this.releaseMicrophone();
            this.discardInput();
            await this.sender?.replaceTrack(null).catch(() => {});
            this.reconcile();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                },
            });
            if (capture !== this.captureGeneration || this.destroyed) {
                for (const track of stream.getTracks()) track.stop();
                return;
            }
            this.releaseMicrophone();
            this.stream = stream;
            const track = stream.getAudioTracks()[0]!;
            track.enabled = !this.value.paused;
            track.addEventListener("ended", () => {
                if (this.stream === stream) void this.microphone(false);
            });
            if (this.sender && this.sessionReady && !this.value.paused)
                await this.sender.replaceTrack(track);
            this.reconcile();
        } catch {
            if (capture !== this.captureGeneration) return;
            this.releaseMicrophone();
            this.update({
                microphone: false,
                error: "Microphone access failed. Allow microphone access in your browser and try again.",
            });
            this.reconcile();
        }
    }

    /** Pause microphone transmission while keeping playback available.
     * @param paused - True disables the source track and removes it from the sender.
     * @returns Completion of media-sender detachment or reattachment.
     */
    async pause(paused: boolean) {
        if (!this.value.microphone) return;
        this.update({ paused, transcript: "" });
        for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !paused;
        await this.sender
            ?.replaceTrack(
                paused || !this.sessionReady
                    ? null
                    : (this.stream?.getAudioTracks()[0] ?? null)
            )
            .catch(() => {});
        this.discardInput();
    }
    /** Toggle spoken replies without changing microphone capture.
     * @param enabled - Whether new Mira replies should be read aloud.
     */
    speech(enabled: boolean) {
        this.update({ speech: enabled, error: "" });
        if (!enabled) this.stopSpeaking();
        this.reconcile();
    }
    /** Change only the audio model and establish a fresh audio session.
     * @param model - Operator-selected model from the current API catalog.
     */
    model(model: string) {
        this.update({ model, error: "" });
        try {
            localStorage.setItem(`mira.voice.model:${this.conversationId}`, model);
        } catch {
            /* Optional preference storage. */
        }
        this.closeConnection();
        this.attempts = 0;
        this.reconcile();
    }
    /** Select the built-in speaking voice for new and historical replies.
     * @param voice - One supported voice; changing it requires a new OpenAI session.
     */
    speakingVoice(voice: MiraVoiceName) {
        this.update({ voice, error: "" });
        try {
            localStorage.setItem(`mira.voice.name:${this.conversationId}`, voice);
        } catch {
            /* Optional preference storage. */
        }
        this.closeConnection();
        this.attempts = 0;
        this.reconcile();
    }
    /** Stop reading aloud; the Mira task and its queued messages continue. */
    stopSpeaking() {
        this.cancelSpeech();
        this.reconcile();
    }
    private cancelSpeech() {
        this.reading = false;
        this.speechQueue = [];
        this.audio.muted = true;
        if (this.responseId && !this.responseDone)
            this.emit({ type: "response.cancel", response_id: this.responseId });
        this.emit({ type: "output_audio_buffer.clear" });
        this.responseId = undefined;
        this.speechRequestId = undefined;
        this.update({ speaking: false, readingId: null });
    }
    /** Observe durable replies once; history and reconnects never replay old speech.
     * @param messages - Latest page of the selected conversation, including streamed parts.
     */
    messages(messages: readonly MiraMessage[]) {
        for (const message of messages) {
            if (
                message.role !== "assistant" ||
                message.state !== "completed" ||
                !message.content.trim() ||
                this.spoken.has(message.id)
            )
                continue;
            this.spoken.add(message.id);
            if (!this.initialized || !this.value.speech) continue;
            this.queueSpeech(message);
        }
        this.initialized = true;
        this.pumpSpeech();
        void this.sendPending();
    }
    /** Read one earlier reply without enabling automatic spoken replies.
     * @param message - Visible assistant message selected by the operator.
     */
    read(message: MiraMessage) {
        if (this.value.readingId === message.id) {
            this.stopSpeaking();
            return;
        }
        this.cancelSpeech();
        this.reading = true;
        this.queueSpeech(message);
        this.reconcile();
        this.pumpSpeech();
    }
    private queueSpeech(message: MiraMessage) {
        const text = message.content
            .replaceAll(/```[\s\S]*?```/g, " Code is shown in the conversation. ")
            .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        for (let start = 0; start < text.length; start += 1600)
            this.speechQueue.push({
                id: message.id,
                text: text.slice(start, start + 1600),
            });
    }
    /** Retry an unavailable connection or an unacknowledged text submission. */
    retry() {
        clearTimeout(this.sendTimer);
        this.sendTimer = undefined;
        void this.audio.play().catch(() => {});
        this.attempts = 0;
        this.update({ error: "" });
        this.reconcile();
        void this.sendPending();
    }
    /** Discard unsent transcripts; previously accepted task work is not cancelled. */
    discardPending() {
        this.outbox = [];
        this.persist();
    }
    /** Attach lifecycle ownership, including React development remounts. */
    mount() {
        this.destroyed = false;
        this.update({
            microphone: false,
            paused: false,
            speech: false,
            speaking: false,
            readingId: null,
            transcript: "",
            error: "",
            connection: "off",
        });
    }
    /** Release all media, timers and callbacks when leaving this conversation. */
    destroy() {
        this.destroyed = true;
        this.captureGeneration++;
        this.closeConnection();
        this.releaseMicrophone();
        clearTimeout(this.sendTimer);
        this.sendTimer = undefined;
    }
    private releaseMicrophone() {
        const stream = this.stream;
        this.stream = undefined;
        for (const track of stream?.getTracks() ?? []) track.stop();
    }
    private discardInput() {
        for (const item of this.utterances.values())
            if (item.text === null) item.discarded = true;
        this.emit({ type: "input_audio_buffer.clear" });
        this.flushTranscripts();
    }
    private reconcile() {
        if (this.destroyed) return;
        if (!this.value.microphone && !this.value.speech && !this.reading) {
            this.closeConnection();
            this.update({ connection: "off" });
            return;
        }
        if (!this.pc) void this.connect();
    }
    private closeConnection() {
        this.generation++;
        this.sessionReady = false;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.renewalTimer);
        clearTimeout(this.connectionTimer);
        this.cancelSpeech();
        this.channel?.close();
        this.pc?.close();
        this.channel = undefined;
        this.pc = undefined;
        this.sender = undefined;
        this.audio.srcObject = null;
        this.utterances.clear();
    }
    private async connect() {
        const pc = new RTCPeerConnection();
        this.pc = pc;
        const generation = ++this.generation;
        const current = () => !this.destroyed && this.generation === generation;
        this.update({ connection: "connecting" });
        try {
            this.sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
            pc.ontrack = (event) => {
                if (!current()) return;
                this.audio.srcObject = new MediaStream([event.track]);
                void this.audio.play().catch(() =>
                    this.update({
                        error: "Your browser paused audio playback. Press Retry to allow spoken replies.",
                    })
                );
            };
            const channel = pc.createDataChannel("oai-events");
            this.channel = channel;
            channel.addEventListener("message", (event: MessageEvent<string>) => {
                if (!current()) return;
                try {
                    this.event(v.parse(eventSchema, JSON.parse(event.data)));
                } catch {
                    this.update({
                        error: "Voice received an unreadable event. Text chat is still available.",
                    });
                }
            });
            channel.addEventListener("open", () => {
                if (!current()) return;
                this.renewalTimer = setTimeout(() => {
                    if (current()) {
                        this.closeConnection();
                        this.reconcile();
                    }
                }, 55 * 60_000);
            });
            const disconnected = () => {
                if (!current()) return;
                this.closeConnection();
                this.update({
                    connection: "reconnecting",
                    transcript: "",
                    error: "Voice disconnected. Completed messages are saved; please repeat any unfinished speech.",
                });
                if (++this.attempts <= 6)
                    this.reconnectTimer = setTimeout(
                        () => this.reconcile(),
                        Math.min(15_000, 1000 * 2 ** (this.attempts - 1))
                    );
                else this.update({ connection: "error" });
            };
            this.connectionTimer = setTimeout(disconnected, 60_000);
            channel.addEventListener("close", disconnected);
            pc.onconnectionstatechange = () => {
                if (["failed", "disconnected"].includes(pc.connectionState))
                    disconnected();
            };
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const answer = await api.mira.voice.connect.mutate({
                conversationId: this.conversationId,
                model: this.value.model,
                voice: this.value.voice,
                sdp: offer.sdp!,
            });
            if (!current()) return;
            await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        } catch (error) {
            if (!current()) return;
            this.closeConnection();
            this.update({
                connection: "error",
                error:
                    error instanceof Error
                        ? error.message
                        : "Voice could not connect. Retry when the network is available.",
            });
            if (++this.attempts <= 6)
                this.reconnectTimer = setTimeout(
                    () => this.reconcile(),
                    Math.min(15_000, 1000 * 2 ** (this.attempts - 1))
                );
        }
    }
    private event(event: v.InferOutput<typeof eventSchema>) {
        if (
            ["session.created", "session.updated"].includes(event.type) &&
            event.session
        ) {
            const input = event.session.audio.input;
            if (
                input.turn_detection.create_response ||
                input.turn_detection.interrupt_response ||
                input.transcription?.model !== "gpt-transcribe" ||
                event.session.tools.length > 0
            ) {
                // Unified SDP setup can announce defaults before applying the server configuration.
                if (event.type === "session.created") return;
                this.closeConnection();
                this.update({
                    connection: "error",
                    error: "Voice configuration was not accepted. Choose another voice model or retry.",
                });
                return;
            }
            clearTimeout(this.connectionTimer);
            this.sessionReady = true;
            this.attempts = 0;
            this.update({ connection: "connected", error: "" });
            if (this.value.microphone && !this.value.paused)
                void this.sender
                    ?.replaceTrack(this.stream?.getAudioTracks()[0] ?? null)
                    .catch(() => {});
            this.pumpSpeech();
        }
        if (event.type === "input_audio_buffer.speech_started" && event.item_id) {
            this.utterances.set(event.item_id, {
                id: crypto.randomUUID(),
                text: null,
                discarded: !this.value.microphone || this.value.paused,
            });
            if (this.value.microphone && !this.value.paused) {
                this.stopSpeaking();
                this.update({ transcript: "Listening…" });
            }
        }
        if (
            event.type === "conversation.item.input_audio_transcription.delta" &&
            event.item_id
        ) {
            const item = this.utterances.get(event.item_id);
            if (item && !item.discarded)
                this.update({
                    transcript:
                        (this.value.transcript === "Listening…"
                            ? ""
                            : this.value.transcript) + (event.delta ?? ""),
                });
        }
        if (
            [
                "conversation.item.input_audio_transcription.completed",
                "conversation.item.input_audio_transcription.failed",
            ].includes(event.type) &&
            event.item_id
        ) {
            const item = this.utterances.get(event.item_id);
            if (item && item.text === null) item.text = event.transcript?.trim() ?? "";
            this.emit({ type: "conversation.item.delete", item_id: event.item_id });
            if (event.type.endsWith("failed"))
                this.update({
                    error: "Speech could not be transcribed. Please repeat it or type your message.",
                });
            this.flushTranscripts();
        }
        if (event.type === "response.created" && event.response) {
            if (event.response.metadata?.speechId !== this.speechRequestId) {
                this.emit({ type: "response.cancel", response_id: event.response.id });
                return;
            }
            this.responseId = event.response.id;
        }
        if (
            event.type === "output_audio_buffer.started" &&
            event.response_id === this.responseId &&
            (this.value.speech || this.reading)
        )
            this.audio.muted = false;
        if (
            event.type === "output_audio_buffer.stopped" &&
            event.response_id === this.responseId
        ) {
            this.playbackDone = true;
            this.finishSpeech();
        }
        if (
            event.type === "response.done" &&
            event.response &&
            event.response.id === this.responseId
        ) {
            this.responseDone = true;
            if (event.response.status !== "completed") {
                this.playbackDone = true;
                if (event.response.status !== "cancelled")
                    this.update({
                        error: "OpenAI could not read this reply. The full text remains in the conversation.",
                    });
            }
            this.finishSpeech();
        }
        if (event.type === "error") {
            this.stopSpeaking();
            this.update({
                error: "OpenAI voice reported an error. Text chat is still available; retry voice if needed.",
            });
        }
    }
    private flushTranscripts() {
        for (const [key, item] of this.utterances) {
            if (item.text === null && !item.discarded) break;
            this.utterances.delete(key);
            if (!item.discarded && item.text && /[\p{L}\p{N}]/u.test(item.text)) {
                this.outbox.push({ id: item.id, text: item.text });
                this.update({ transcript: item.text });
            }
        }
        this.persist();
        void this.sendPending();
    }
    private async sendPending() {
        if (this.sending || this.destroyed || this.sendTimer !== undefined) return;
        const next = this.outbox[0];
        if (!next) return;
        this.sending = true;
        try {
            await api.mira.conversations.send.mutate({
                conversationId: this.conversationId,
                requestId: next.id,
                text: next.text,
                attachmentIds: [],
            });
            this.outbox = this.outbox.filter((item) => item.id !== next.id);
            this.persist();
            this.changed();
        } catch {
            this.update({
                error: "A voice transcript is waiting to send. Retry or discard it below; retrying cannot duplicate an accepted message.",
            });
            this.sendTimer = setTimeout(() => {
                this.sendTimer = undefined;
                void this.sendPending();
            }, 5000);
            return;
        } finally {
            this.sending = false;
        }
        void this.sendPending();
    }
    private speechRequestId: string | undefined;
    private pumpSpeech() {
        if (
            (!this.value.speech && !this.reading) ||
            this.value.speaking ||
            this.channel?.readyState !== "open" ||
            !this.sessionReady
        )
            return;
        const next = this.speechQueue.shift();
        if (!next) return;
        this.speechRequestId = crypto.randomUUID();
        this.responseDone = false;
        this.playbackDone = false;
        this.update({ speaking: true, readingId: next.id });
        this.emit({
            type: "response.create",
            response: {
                conversation: "none",
                output_modalities: ["audio"],
                metadata: { speechId: this.speechRequestId },
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: next.text }],
                    },
                ],
            },
        });
    }
    private finishSpeech() {
        if (!this.responseDone || !this.playbackDone) return;
        this.responseId = undefined;
        this.speechRequestId = undefined;
        this.update({ speaking: false, readingId: null });
        if (this.speechQueue.length === 0) {
            this.reading = false;
            this.reconcile();
        }
        this.pumpSpeech();
    }
}
