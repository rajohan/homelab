import { DropdownMenu, type DropdownMenuAction } from "@homelab/ui";
import {
    ClipboardPaste,
    Copy,
    Download,
    Maximize,
    Minimize,
    Scan,
    Square,
    Upload,
    ZoomIn,
    ZoomOut,
} from "lucide-react";

import type { BrowserViewControls } from "./BrowserLiveView";

/** Place occasional browser actions behind the same menu used throughout the dashboard.
 * @returns A keyboard-accessible menu for the current display and control grant.
 */
export function BrowserMenu({
    view,
    control,
    busy,
    fullscreen,
    toggleFullscreen,
    files,
    stop,
}: {
    readonly view: BrowserViewControls | null;
    readonly control: boolean;
    readonly busy: boolean;
    readonly fullscreen: boolean;
    readonly toggleFullscreen: (() => void) | null;
    readonly files: (kind: "upload" | "download") => void;
    readonly stop: () => void;
}) {
    const actions: DropdownMenuAction[] = [
        {
            id: "zoom-in",
            label: "Zoom in",
            icon: ZoomIn,
            disabled: !view?.zoomIn,
            onSelect: () => view?.zoomIn?.(),
        },
        {
            id: "zoom-out",
            label: "Zoom out",
            icon: ZoomOut,
            disabled: !view?.zoomOut,
            onSelect: () => view?.zoomOut?.(),
        },
        {
            id: "fit",
            label: "Fit to pane",
            icon: Scan,
            disabled: !view?.fit,
            onSelect: () => view?.fit?.(),
        },
    ];
    if (toggleFullscreen)
        actions.push({
            id: "fullscreen",
            label: fullscreen ? "Exit full screen" : "Full screen",
            icon: fullscreen ? Minimize : Maximize,
            onSelect: toggleFullscreen,
        });
    if (control)
        actions.push(
            {
                id: "copy",
                label: "Copy",
                icon: Copy,
                disabled: !view?.copy,
                onSelect: () => view?.copy?.(),
            },
            {
                id: "paste",
                label: "Paste",
                icon: ClipboardPaste,
                disabled: !view?.paste,
                onSelect: () => view?.paste?.(),
            },
            {
                id: "upload",
                label: "Upload file",
                icon: Upload,
                disabled: busy,
                onSelect: () => files("upload"),
            },
            {
                id: "download",
                label: "Download file",
                icon: Download,
                disabled: busy,
                onSelect: () => files("download"),
            }
        );
    actions.push({
        id: "stop",
        label: "Stop browser",
        icon: Square,
        danger: true,
        disabled: busy,
        onSelect: stop,
    });
    return <DropdownMenu label="Browser menu" actions={actions} />;
}
