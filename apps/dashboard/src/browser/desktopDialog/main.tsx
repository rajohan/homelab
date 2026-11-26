import { createRoot } from "react-dom/client";

import {
    ComputerConsentDialog,
    type ComputerConsentState,
} from "./ComputerConsentDialog";
import { DesktopDialog, type DesktopDialogState } from "./DesktopDialog";

// Only the packaged dialog document receives this host channel.
const host = (
    globalThis as typeof globalThis & {
        chrome: {
            webview: {
                /** Subscribe to presentation changes from the local shell. */
                addEventListener(
                    type: "message",
                    handler: (
                        event: MessageEvent<
                            DesktopDialogState | ComputerConsentState | null
                        >
                    ) => void
                ): void;
                /** Return the user's choice for the displayed dialog revision. */
                postMessage(message: string): void;
            };
        };
    }
).chrome.webview;
const container = document.querySelector("#root");
if (!container) throw new Error("Missing desktop dialog root.");
const root = createRoot(container);
host.addEventListener("message", ({ data }) => {
    if (data?.kind === "consent") {
        root.render(
            <ComputerConsentDialog
                state={data}
                send={(action) => host.postMessage(action)}
            />
        );
        return;
    }
    root.render(
        data && (
            <DesktopDialog
                key={data.kind}
                state={data}
                onAction={(action) =>
                    host.postMessage(
                        action +
                            ":" +
                            (action === "dismiss" ? data.session : data.revision)
                    )
                }
            />
        )
    );
});
host.postMessage("ready");
