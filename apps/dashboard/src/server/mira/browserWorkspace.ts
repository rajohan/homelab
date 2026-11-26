import { connect } from "node:net";

import {
    type MiraBrowserConsole,
    type MiraBrowserTabs,
    miraBrowserTabsSchema,
} from "@homelab/contracts/miraBrowser";
import { browserLiveSocket } from "@homelab/mira/browsing/liveSocket";
import { readMiraBrowserLive } from "@homelab/mira/data/browserLive";
import type { MiraContext } from "@homelab/mira/data/context";
import * as v from "valibot";

/** Load ephemeral Chromium metadata for the current operator and controller generation.
 * @param context - Request-scoped, signed-in Mira operator.
 * @param id - Access whose normal console authorization has already succeeded.
 * @param state - Console epoch, busy flag and file controls from the same request.
 * @param directory - Shared private host socket directory, if a display is installed.
 * @returns The console with actual browser tabs when the host has a current sample.
 */
export async function browserWorkspace(
    context: MiraContext,
    id: string,
    state: MiraBrowserConsole,
    directory?: string
): Promise<MiraBrowserConsole> {
    if (!directory) return state;
    const identity = { owner: context.owner, accessId: id, epoch: state.epoch };
    try {
        const access = await readMiraBrowserLive(context, identity);
        const tabs = await new Promise<MiraBrowserTabs | null>((resolve) => {
            const socket = connect(browserLiveSocket(directory, access.hostId));
            let buffer = Buffer.alloc(0);
            const finish = (value: MiraBrowserTabs | null) => {
                clearTimeout(timer);
                socket.destroy();
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), 1500);
            socket.once("connect", () =>
                socket.write(JSON.stringify({ ...identity, workspace: true }) + "\n")
            );
            socket.once("error", () => finish(null));
            socket.once("close", () => finish(null));
            socket.on("data", (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > 192 * 1024) return finish(null);
                if (buffer.includes(10)) {
                    try {
                        finish(
                            v.parse(
                                v.nullable(miraBrowserTabsSchema),
                                JSON.parse(buffer.toString("utf8"))
                            )
                        );
                    } catch {
                        finish(null);
                    }
                }
            });
        });
        return { ...state, tabs };
    } catch {
        // Starting or retired displays do not prevent the operator from returning control.
        return state;
    }
}
