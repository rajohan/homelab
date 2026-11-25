import { useQuery } from "@tanstack/react-query";

import { hasDesktopBridge, requestDesktop } from "./desktopClient";

/** Read the paired device for this Windows chat. The computer hint routes a local prompt only.
 * @returns A device hint, or an empty object for chats sent from the web.
 */
export function useChatComputer() {
    const desktop = hasDesktopBridge();
    const query = useQuery({
        queryKey: ["mira", "desktop"],
        queryFn: ({ signal }) => requestDesktop({ action: "state" }, signal),
        enabled: desktop,
        retry: false,
    });
    return desktop ? { sourceComputer: query.data?.computerId ?? "unavailable" } : {};
}
