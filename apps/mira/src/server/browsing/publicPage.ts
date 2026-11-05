import type { CDPSession } from "puppeteer-core";

import { browserUrl } from "./policy";

const textInputTypes = ["text", "url", "search", "tel", "email"];

/** Read the current top document identity before observing or applying input.
 * @param cdp - Private connection to one page in the isolated container.
 * @returns The current frame, loader and validated public URL.
 * @param origins - Site scope bound to the session.
 */
export async function publicDocument(cdp: CDPSession, origins: readonly string[]) {
    const {
        frameTree: { frame },
    } = await cdp.send("Page.getFrameTree");
    return { id: frame.id, loader: frame.loaderId, url: browserUrl(frame.url, origins) };
}

/** Read bounded accessibility text and retain exact backend nodes for one observation.
 * @param cdp - Private connection to the selected tab.
 * @param frameId - Current top-level frame only.
 * @param control - Whether input references can be created.
 * @returns Human-readable content and server-owned handles for supported controls.
 */
export async function publicOutline(cdp: CDPSession, frameId: string, control: boolean) {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree", {
        frameId,
        depth: 18,
    });
    // AX uses the same role for ordinary text and passwords. Check the actual element
    // before exposing a field value or an input handle; cap work on large forms.
    const fields = nodes
        .filter(
            (node) =>
                !node.ignored &&
                (!node.frameId || node.frameId === frameId) &&
                node.backendDOMNodeId &&
                ["textbox", "searchbox"].includes(String(node.role?.value))
        )
        .slice(0, 200);
    const editable = new Set<number>();
    await Promise.all(
        fields.map(async (field) => {
            const id = field.backendDOMNodeId!;
            const described = await cdp
                .send("DOM.describeNode", { backendNodeId: id, depth: 0 })
                .catch(() => null);
            if (!described) return;
            const { node } = described;
            if (node.localName === "input") {
                const attributes = node.attributes ?? [];
                const index = attributes.findIndex(
                    (name, i) => i % 2 === 0 && name === "type"
                );
                const type =
                    index === -1
                        ? "text"
                        : attributes[index + 1]?.toLowerCase() || "text";
                if (!textInputTypes.includes(type)) return;
            }
            if (
                field.properties?.some((p) => p.name === "editable" && p.value.value) &&
                !field.properties.some(
                    (p) =>
                        (p.name === "readonly" || p.name === "disabled") && p.value.value
                )
            )
                editable.add(id);
        })
    );
    const refs: {
        ref: string;
        role: string;
        label: string;
        actions: ("click" | "type")[];
    }[] = [];
    const handles = new Map<string, number>();
    const lines: string[] = [];
    let length = 0;
    for (const node of nodes) {
        if (node.ignored || (node.frameId && node.frameId !== frameId)) continue;
        const role = String(node.role?.value ?? "").slice(0, 64);
        const label = String(node.name?.value ?? "").slice(0, 384);
        const href: unknown = node.properties?.find((p) => p.name === "url")?.value.value;
        const fieldValue: unknown = node.value?.value;
        const line = [
            role,
            label,
            node.backendDOMNodeId &&
            editable.has(node.backendDOMNodeId) &&
            typeof fieldValue === "string"
                ? fieldValue.slice(0, 256)
                : "",
            typeof href === "string" ? href.slice(0, 2048) : "",
        ]
            .filter(Boolean)
            .join(" ");
        if (length + line.length > 32_000) break;
        if (label || href) {
            lines.push(line);
            length += line.length + 1;
        }
        if (
            !control ||
            !node.backendDOMNodeId ||
            refs.length >= 200 ||
            node.properties?.some((p) => p.name === "disabled" && p.value.value)
        )
            continue;
        const actions: ("click" | "type")[] = [];
        if (editable.has(node.backendDOMNodeId)) actions.push("type");
        else if (
            ["button", "link", "checkbox", "radio", "tab", "menuitem", "switch"].includes(
                role
            )
        )
            actions.push("click");
        if (actions.length > 0) {
            const ref = `p1:${refs.length + 1}`;
            refs.push({ ref, role, label: label.slice(0, 256), actions });
            handles.set(ref, node.backendDOMNodeId);
        }
    }
    return { outline: lines.join("\n"), refs, handles };
}

/** Dispatch one action to its observed element in an isolated JavaScript world.
 * @param cdp - Current tab connection.
 * @param frameId - Revalidated document frame.
 * @param node - Chromium identity captured in the latest observation.
 * @param action - Validated click or text input, passed only as values to a fixed function.
 */
export async function publicInput(
    cdp: CDPSession,
    frameId: string,
    node: number,
    action: { action: "click" } | { action: "type"; text: string; replace: boolean }
) {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "mira-input",
    });
    const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: node,
        executionContextId,
    });
    if (!object.objectId) throw new Error("The observed element is unavailable.");
    try {
        const result = await cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            userGesture: true,
            returnByValue: true,
            arguments: [{ value: action }],
            functionDeclaration: `function(action) {
                if (!(this instanceof HTMLElement) || !this.isConnected || !this.checkVisibility() || this.matches(":disabled,input[type=password],input[type=file]")) return false;
                if (action.action === "click") { this.click(); return true; }
                const nativeField = this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement && ${JSON.stringify(textInputTypes)}.includes(this.type);
                if (!(nativeField || this.isContentEditable) || this.readOnly || this.matches("[aria-readonly=true],[aria-disabled=true]")) return false;
                this.focus();
                if (document.activeElement !== this) return false;
                if (nativeField) {
                    if (action.replace) this.select();
                    else if (this.selectionEnd !== null) this.setSelectionRange(this.value.length,this.value.length);
                } else {
                    const selection = document.getSelection();
                    if (!selection) return false;
                    const range = document.createRange();
                    range.selectNodeContents(this);
                    if (!action.replace) range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                }
                return document.execCommand("insertText",false,action.text);
            }`,
        });
        if (result.exceptionDetails || result.result.value !== true)
            throw new Error("Browser input could not be confirmed.");
    } finally {
        await cdp
            .send("Runtime.releaseObject", { objectId: object.objectId })
            .catch(() => {});
    }
}
