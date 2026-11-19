import { connect, type Socket } from "node:net";

import { browserLiveSocket } from "@homelab/mira/browsing/liveSocket";
import { readMiraBrowserLive } from "@homelab/mira/data/browserLive";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import * as v from "valibot";

import { authorizedOperations } from "../operations/authorization";
import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";

const uuid = v.pipe(v.string(), v.uuid());
export interface BrowserDisplaySocket {
    directory: string;
    hostId: string;
    identity: { owner: string; accessId: string; epoch: string | null; inputOnly?: true };
    verify: () => Promise<void>;
    socket?: Socket;
    timer?: ReturnType<typeof setTimeout>;
    closed: boolean;
    control: boolean;
}

function close(ws: ServerWebSocket<BrowserDisplaySocket>) {
    if (ws.data.closed) return;
    ws.data.closed = true;
    clearTimeout(ws.data.timer);
    ws.data.socket?.destroy();
    ws.close(1000, "Browser display disconnected.");
}

/** Authorize a browser-session WebSocket before upgrading the request.
 * @param request - Same-origin browser upgrade, verified at the HTTP boundary.
 * @param context - Session identity and the existing operations runtime.
 * @returns Private routing, with a verifier retained for the entire connection.
 */
export async function prepareBrowserDisplay(
    request: Request,
    context: OperationsContext
): Promise<BrowserDisplaySocket> {
    const { operations, principal } = authorizedOperations(context, "jobs:read");
    if (
        principal.kind !== "human" ||
        !context.verifyHuman ||
        !operations.miraFilesDirectory
    )
        throw new OperationFailure("FORBIDDEN", "Sign in to view this browser.");
    const url = new URL(request.url);
    const identity = {
        owner: principal.id,
        accessId: v.parse(uuid, url.searchParams.get("id")),
        epoch: v.parse(v.nullable(uuid), url.searchParams.get("epoch")),
        ...(url.searchParams.get("input") === "1" ? { inputOnly: true as const } : {}),
    };
    const mira = {
        client: operations.client,
        owner: principal.id,
        actor: `human:${principal.id}`,
    };
    const initial = await readMiraBrowserLive(mira, identity);
    const verify = async () => {
        const current = await context.verifyHuman!();
        if (current.kind !== "human" || current.id !== principal.id)
            throw new Error("Browser identity changed.");
        const access = await readMiraBrowserLive(mira, identity);
        if (
            access.hostId !== initial.hostId ||
            access.processId !== initial.processId ||
            access.control !== initial.control
        )
            throw new Error("Browser control changed.");
    };
    await verify();
    return {
        directory: operations.miraFilesDirectory,
        hostId: initial.hostId,
        identity,
        verify,
        closed: false,
        control: initial.control,
    };
}

/** Relay RFB only through the current owner's authenticated console connection. */
export const browserDisplayHandlers: WebSocketHandler<BrowserDisplaySocket> = {
    maxPayloadLength: 64 * 1024,
    backpressureLimit: 4 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 0,
    /** Attach the authenticated browser socket to its private host stream.
     * @param ws - Authorized viewer connection.
     */
    open(ws) {
        const socket = connect(browserLiveSocket(ws.data.directory, ws.data.hostId));
        ws.data.socket = socket;
        socket.on("error", () => close(ws));
        socket.on("close", () => close(ws));
        socket.on("connect", () => socket.write(JSON.stringify(ws.data.identity) + "\n"));
        socket.on("data", (bytes: Buffer) => {
            if (!ws.data.closed && ws.send(bytes) === 0) close(ws);
        });
        const verify = () => {
            if (ws.data.closed) return;
            void ws.data.verify().then(
                () => {
                    if (!ws.data.closed) ws.data.timer = setTimeout(verify, 1000);
                    return;
                },
                () => close(ws)
            );
        };
        verify();
    },
    /** Forward bounded binary viewer input without retrying delivery.
     * @param ws - Authorized viewer connection.
     * @param message - One binary RFB packet.
     */
    message(ws, message) {
        const socket = ws.data.socket;
        if (
            typeof message === "string" ||
            !socket ||
            socket.destroyed ||
            socket.writableLength > 64 * 1024
        ) {
            close(ws);
            return;
        }
        socket.write(message);
    },
    /** Release the host connection when the web viewer closes.
     * @param ws - Closed viewer connection.
     */
    close(ws) {
        ws.data.closed = true;
        clearTimeout(ws.data.timer);
        ws.data.socket?.destroy();
    },
};
