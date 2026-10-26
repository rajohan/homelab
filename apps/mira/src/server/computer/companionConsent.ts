import type { MiraComputerConsentRequest } from "@homelab/contracts/miraComputers";

import type { ComputerCompanion } from "./companion";
import { computerWindowGrant, type ComputerWindowGrant } from "./policy";
import { ComputerWindowSession, type ComputerWindowPort } from "./session";

export interface ComputerConsentHost {
    /**
     * Ask the local user to approve the displayed scope and select one native window.
     * @param request - Server metadata, never window names or executable instructions.
     * @param signal - Stop, connection loss or the one-minute consent deadline.
     * @returns A locally resolved immutable target, or null for rejection. Never auto-approve.
     */
    select(
        request: Readonly<MiraComputerConsentRequest>,
        signal: AbortSignal
    ): Promise<ComputerWindowGrant | null>;
    /**
     * Verify the interactive desktop and the same executable/process/window are still ready.
     * @param target - Locally selected identity; reused without rediscovery or fallback.
     * @param signal - Local retirement, including the short server-permit deadline.
     * @returns Completion only for the unlocked, connected, authorized desktop and exact target.
     */
    assertReady(
        target: Readonly<ComputerWindowGrant>,
        signal: AbortSignal
    ): Promise<void>;
    /**
     * Open the supervised native child after consent and a fresh server gate.
     * @param target - Frozen local selection with an explicit view/control ceiling.
     * @param signal - Permanent local stop; child startup and work must honor it.
     * @returns Exclusive process-owned driver; cleanup must wait for actual process exit.
     */
    open(
        target: Readonly<ComputerWindowGrant>,
        signal: AbortSignal
    ): Promise<ComputerWindowPort>;
}

/** One local consent attempt and controller, permanently bound to one connection generation. */
export class ComputerConsentController {
    private readonly options: {
        companion: Pick<
            ComputerCompanion,
            "pendingAccess" | "acceptAccess" | "permitAccess" | "stopAccess"
        >;
        credential: string;
        connectionId: string;
        signal: AbortSignal;
        host: ComputerConsentHost;
        now?: () => number;
    };
    private readonly abort = new AbortController();
    private readonly now: () => number;
    private readonly stopListener: () => void;
    private request?: MiraComputerConsentRequest;
    private target?: Readonly<ComputerWindowGrant>;
    private targetId?: string;
    private session?: ComputerWindowSession;
    private opening?: Promise<ComputerWindowPort>;
    private closing?: Promise<void>;
    private checking: Promise<void> | undefined;
    private reviewing = false;
    private attempted = false;
    private deadline = 0;
    private consentDeadline = 0;
    private expiryTimer?: ReturnType<typeof setTimeout>;
    private permitTimer?: ReturnType<typeof setTimeout>;
    private refreshTimer?: ReturnType<typeof setTimeout>;

    /**
     * Bind a local-only consent surface to one authenticated outbound connection.
     * @param options - Fixed generation, OS-vault credential, local hooks and cancellation.
     */
    constructor(options: ComputerConsentController["options"]) {
        this.options = options;
        this.now = options.now ?? (() => performance.now());
        this.stopListener = () => {
            void this.close().catch(() => {});
        };
        options.signal.addEventListener("abort", this.stopListener, { once: true });
        if (options.signal.aborted) this.stopListener();
    }

    /**
     * Poll for one pending request and obtain explicit consent before opening any native port.
     * @returns True only after local selection, single-use server acceptance and readiness checks.
     */
    async review(): Promise<boolean> {
        this.assertLive();
        if (this.reviewing || this.attempted)
            throw new Error("Computer consent was already requested.");
        this.reviewing = true;
        try {
            const request = await this.options.companion.pendingAccess(
                this.options.credential,
                this.options.connectionId,
                this.abort.signal
            );
            this.assertLive();
            if (!request) return false;
            this.attempted = true;
            this.request = Object.freeze({ ...request });
            const remaining = Math.min(
                300_000,
                Date.parse(request.expiresAt) - Date.now()
            );
            if (!Number.isFinite(remaining) || remaining <= 0)
                throw new Error("Computer consent expired.");
            this.deadline = this.now() + remaining;
            const consentRemaining = Math.min(
                60_000,
                remaining,
                Date.parse(request.consentExpiresAt) - Date.now()
            );
            if (!Number.isFinite(consentRemaining) || consentRemaining <= 0)
                throw new Error("Computer consent expired.");
            this.consentDeadline = this.now() + consentRemaining;
            this.expiryTimer = setTimeout(this.stopListener, consentRemaining);
            const selected = await this.options.host.select(
                this.request,
                this.abort.signal
            );
            this.assertLive();
            if (!selected) {
                await this.close();
                return false;
            }
            this.target = Object.freeze(
                computerWindowGrant({ ...selected, mode: request.mode })
            );
            this.targetId = crypto.randomUUID();
            await this.options.host.assertReady(this.target, this.abort.signal);
            this.assertLive();
            const receipt = await this.options.companion.acceptAccess(
                this.options.credential,
                {
                    id: request.id,
                    connectionId: this.options.connectionId,
                    targetId: this.targetId,
                },
                this.abort.signal
            );
            this.assertLive();
            if (
                receipt.id !== request.id ||
                receipt.computerId !== request.computerId ||
                receipt.runId !== request.runId ||
                receipt.mode !== request.mode ||
                receipt.state !== "active" ||
                receipt.expiresAt !== request.expiresAt
            )
                throw new Error("Computer consent receipt changed.");
            this.consentDeadline = 0;
            clearTimeout(this.expiryTimer);
            this.expiryTimer = setTimeout(
                this.stopListener,
                Math.max(0, this.deadline - this.now())
            );
            await this.check();
            this.assertLive();
            this.opening = Promise.resolve().then(() => {
                this.assertLive();
                return this.options.host.open(this.target!, this.abort.signal);
            });
            const port = await this.opening;
            this.assertLive();
            this.session = new ComputerWindowSession(port, () => this.check(), this.now);
            await this.check();
            return true;
        } catch (error) {
            await this.close();
            throw error;
        } finally {
            this.reviewing = false;
        }
    }

    /**
     * Read the consented window with live gates before and after capture.
     * @param signal - Cancellation of this one operation; interruption retires local authority.
     * @returns A bounded frame with a fresh, single-use observation identity.
     */
    async observe(signal: AbortSignal) {
        try {
            return await this.active().observe(signal);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Deliver one scoped input; view-only consent can never call the native input port.
     * @param input - Fixed click/type operation against a fresh local observation.
     * @param signal - Operation cancellation; possibly delivered input is never replayed.
     * @returns The native effect, preserving unknown and partial outcomes.
     */
    async act(input: unknown, signal: AbortSignal) {
        const session = this.active();
        if (this.request?.mode !== "control")
            throw new Error("Computer access is view-only.");
        try {
            const result = await session.act(input, signal);
            if (result.effect === "unknown") await this.close();
            return result;
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Immediately abort local authority, reap any starting/active driver, then record server stop.
     * @returns Shared cleanup; callers must await it before opening a replacement controller.
     */
    close(): Promise<void> {
        this.abort.abort();
        clearTimeout(this.expiryTimer);
        clearTimeout(this.permitTimer);
        clearTimeout(this.refreshTimer);
        this.options.signal.removeEventListener("abort", this.stopListener);
        this.closing ??= (async () => {
            try {
                if (this.session) await this.session.close();
                else if (this.opening) {
                    const port = await this.opening.catch(() => null);
                    await port?.close();
                }
            } finally {
                if (this.request)
                    await this.options.companion
                        .stopAccess(
                            this.options.credential,
                            this.request.id,
                            AbortSignal.timeout(10_000)
                        )
                        .catch(() => {});
            }
        })();
        return this.closing;
    }

    private active() {
        try {
            this.assertLive();
        } catch (error) {
            this.stopListener();
            throw error;
        }
        if (!this.session) throw new Error("Computer access is awaiting local consent.");
        return this.session;
    }
    private assertLive() {
        this.abort.signal.throwIfAborted();
        this.options.signal.throwIfAborted();
        if (this.consentDeadline && this.now() >= this.consentDeadline)
            throw new Error("Computer consent expired.");
        if (this.deadline && this.now() >= this.deadline)
            throw new Error("Computer access expired.");
    }
    private check(): Promise<void> {
        this.checking ??= this.refresh().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }
    private async refresh(): Promise<void> {
        try {
            this.assertLive();
            const started = this.now();
            const permit = await this.options.companion.permitAccess(
                this.options.credential,
                {
                    id: this.request!.id,
                    connectionId: this.options.connectionId,
                    targetId: this.targetId!,
                    mode: this.request!.mode,
                },
                this.abort.signal
            );
            this.assertLive();
            const until = Math.min(this.deadline, started + permit.validForMs);
            if (
                permit.mode !== this.request!.mode ||
                this.now() < started ||
                this.now() >= until
            )
                throw new Error("Computer permit expired in transit.");
            clearTimeout(this.permitTimer);
            this.permitTimer = setTimeout(this.stopListener, until - this.now());
            await this.options.host.assertReady(this.target!, this.abort.signal);
            this.assertLive();
            if (this.now() < started || this.now() >= until)
                throw new Error("Computer permit expired during readiness checks.");
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(
                () => {
                    void this.check().catch(() => {});
                },
                Math.min(1000, Math.max(1, (until - this.now()) / 2))
            );
        } catch (error) {
            this.stopListener();
            throw error;
        }
    }
}
