import type { CDPSession } from "puppeteer-core";

import { type BrowserDownloadFile, browserDownloadLimit } from "./downloadTransfer";

async function resolve(cdp: CDPSession, frameId: string, node: number) {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "mira-file-transfer",
    });
    const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: node,
        executionContextId,
    });
    if (!object.objectId) throw new Error("The selected file control is unavailable.");
    return object.objectId;
}

/** Assign only a host-staged attachment to the observed top-level file input.
 * @param cdp - Private connection to the selected page.
 * @param frameId - Revalidated top-level document.
 * @param node - One-use observed Chromium node.
 * @param file - Immutable file staged in the session's private directory.
 * @param origin - Website bound to the operator's observation.
 * @param clicked - A hidden field requires its visible label or a browser-confirmed native picker.
 * @returns Completion after Chromium accepts the assignment; delivery still requires observation.
 */
export async function publicUpload(
    cdp: CDPSession,
    frameId: string,
    node: number,
    file: string,
    origin: string,
    clicked?: "label" | "chooser"
): Promise<void> {
    const objectId = await resolve(cdp, frameId, node);
    try {
        const result = await cdp.send("Runtime.callFunctionOn", {
            objectId,
            returnByValue: true,
            arguments: [{ value: origin }, { value: clicked ?? null }],
            functionDeclaration: `function(origin, clicked) {
                return location.origin === origin && this instanceof HTMLInputElement &&
                    this.type === "file" && this.isConnected && (this.checkVisibility() ||
                        clicked === "chooser" || (clicked === "label" && [...this.labels].some(label => label.checkVisibility()))) &&
                    !this.disabled && (!this.form || new URL(this.form.action).origin === origin);
            }`,
        });
        if (result.exceptionDetails || result.result.value !== true)
            throw new Error("The upload field or confirmed website changed.");
        await cdp.send("DOM.setFileInputFiles", { objectId, files: [file] });
    } finally {
        await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
}

/** Fetch a human-selected same-origin link without enabling ordinary browser downloads.
 * @param cdp - Private connection to the selected page.
 * @param frameId - Revalidated top-level document.
 * @param node - One-use observed anchor node.
 * @param origin - Website bound to the operator's observation.
 * @param signal - Current operation cancellation; the enclosing session closes Chromium on abort.
 * @param originalHref - URL of the exact link activated by the operator.
 * @returns At most 25 MiB of immutable bytes and a verified digest, never a website-selected path.
 */
export async function publicDownload(
    cdp: CDPSession,
    frameId: string,
    node: number,
    origin: string,
    signal: AbortSignal,
    originalHref?: string | null
): Promise<BrowserDownloadFile> {
    signal.throwIfAborted();
    const objectId = await resolve(cdp, frameId, node);
    try {
        const result = await cdp.send("Runtime.callFunctionOn", {
            objectId,
            awaitPromise: true,
            returnByValue: true,
            arguments: [
                { value: origin },
                { value: browserDownloadLimit },
                { value: originalHref ?? null },
            ],
            functionDeclaration: `async function(origin, limit, originalHref) {
                if (location.origin !== origin || !(this instanceof HTMLAnchorElement) ||
                    !this.isConnected || !this.checkVisibility()) return null;
                const url = new URL(this.href);
                if (originalHref !== null && originalHref !== url.href) return null;
                if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) ||
                    url.username || url.password) return null;
                const response = await fetch(url.href, {
                    credentials: "include", redirect: "error", signal: AbortSignal.timeout(10000)
                });
                if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
                    await response.body?.cancel();
                    return null;
                }
                const reader = response.body.getReader();
                const chunks = [];
                let size = 0;
                try {
                    for (;;) {
                        const {value, done} = await reader.read();
                        if (done) break;
                        size += value.length;
                        if (size > limit) { await reader.cancel(); return null; }
                        for (let start = 0; start < value.length; start += 16384)
                            chunks.push(String.fromCharCode(...value.subarray(start, start + 16384)));
                    }
                    return size ? btoa(chunks.join("")) : null;
                } finally { reader.releaseLock(); }
            }`,
        });
        signal.throwIfAborted();
        const data: unknown = result.result.value;
        if (
            result.exceptionDetails ||
            typeof data !== "string" ||
            data.length > Math.ceil(browserDownloadLimit / 3) * 4
        )
            throw new Error(
                "Choose a file link on this website, without redirects, up to 25 MiB."
            );
        const bytes = Buffer.from(data, "base64");
        if (
            bytes.length === 0 ||
            bytes.length > browserDownloadLimit ||
            bytes.toString("base64") !== data
        )
            throw new Error("The browser returned an invalid file.");
        return {
            bytes,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        };
    } finally {
        await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
}
