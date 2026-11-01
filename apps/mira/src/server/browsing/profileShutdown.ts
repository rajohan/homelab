import path from "node:path";

import { browserEndpoint } from "./endpoint";
import { browserProfileDirectory } from "./profile";

/**
 * Capture a close-only endpoint after the native driver attests its own browser PID.
 * @param pid - The verified driver-launched Chromium process in this container.
 * @param directory - Fixed private profile root; temporary storage is for qualification only.
 * @param proc - Linux process metadata root; synthetic metadata is for tests only.
 * @returns A bounded normal-close attempt, followed by the caller's unconditional SDK shutdown.
 */
export async function prepareBrowserProfileShutdown(
    pid: number,
    directory = browserProfileDirectory,
    proc = "/proc"
): Promise<() => Promise<void>> {
    const endpoint = await browserEndpoint(pid, path.join(directory, "saved"), proc);
    return async () => {
        if (!(await endpoint.alive())) return;
        await new Promise<void>((resolve) => {
            const socket = new WebSocket(endpoint.url);
            let finished = false;
            const timer = setTimeout(finish, 1200);
            const poll = setInterval(() => {
                void endpoint.alive().then((current) => {
                    if (!current) finish();
                    return current;
                });
            }, 25);
            function finish() {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                clearInterval(poll);
                socket.close();
                resolve();
            }
            socket.addEventListener("open", () =>
                socket.send('{"id":1,"method":"Browser.close"}')
            );
            socket.addEventListener("error", finish);
            // A closed CDP socket alone does not prove that Chromium has flushed
            // its profile. Wait for this exact process to exit, within the bound.
        });
    };
}
