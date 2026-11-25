import type { CDPSession } from "puppeteer-core";
import * as v from "valibot";

import type { BrowserGrant } from "./policy";
import { publicDocument } from "./publicPage";

// The page cannot call into this isolated world or forge a trusted activation. Only the
// top document of the operator's current tab is armed, for one short renewable interval.
const sample = `function(epoch, uploads, downloads, responseUrl, responseName, responseAt, chooser, chooserAt) {
    let listener = globalThis.miraFileListener;
    if (!listener) {
        listener = globalThis.miraFileListener = {epoch:null, until:0, target:null};
        window.addEventListener("click", event => {
            if (!event.isTrusted || !listener.epoch || event.button !== 0 ||
                performance.now() >= listener.until) return;
            const path = event.composedPath();
            listener.activation = Date.now();
            listener.trigger = path.find(item => item instanceof HTMLElement && item.checkVisibility());
            listener.target = null;
            const label = path.find(x => x instanceof HTMLLabelElement);
            const input = path.find(x => x instanceof HTMLInputElement) || label?.control;
            let element, kind, href = null, name = null, ready = true;
            if (listener.uploads && input instanceof HTMLInputElement && input.type === "file" &&
                !input.disabled && input.isConnected && (input.checkVisibility() || label?.checkVisibility()) &&
                (!input.form || new URL(input.form.action).origin === location.origin)) {
                element = input; kind = "upload";
            } else if (listener.downloads) {
                const anchor = path.find(x => x instanceof HTMLAnchorElement && x.hasAttribute("href"));
                if (!anchor || !anchor.checkVisibility()) return;
                const url = new URL(anchor.href);
                if (!["https:", "http:"].includes(url.protocol) || url.origin !== location.origin ||
                    url.username || url.password) return;
                element = anchor; kind = "download"; href = url.href;
                ready = anchor.hasAttribute("download"); name = anchor.download || null;
            } else return;
            if (ready) event.preventDefault();
            listener.target = {element, kind, href, name, ready, at:Date.now(),
                label: (element.getAttribute("aria-label") || label?.innerText || element.innerText ||
                    (kind === "upload" ? "Choose file" : "Download file")).trim().slice(0,256)};
        }, true);
    }
    if (listener.epoch !== epoch || performance.now() >= listener.until) {
        listener.target = null; listener.activation = null; listener.trigger = null;
    }
    listener.epoch = epoch; listener.uploads = uploads; listener.downloads = downloads;
    listener.until = epoch ? performance.now() + 1800 : 0;
    if (epoch && uploads && listener.activation && chooserAt >= listener.activation &&
        chooserAt - listener.activation < 650 && Date.now() - chooserAt < 1800 &&
        chooser instanceof HTMLInputElement && chooser.isConnected && chooser.type === "file" &&
        !chooser.disabled && (!chooser.form || new URL(chooser.form.action).origin === location.origin)) {
        const trigger = listener.trigger;
        listener.activation = null; listener.target = null; listener.trigger = null;
        return {element:chooser,kind:"upload",href:null,name:null,native:true,
            label:(chooser.getAttribute("aria-label") || trigger?.getAttribute("aria-label") ||
                trigger?.innerText || "Choose file").trim().slice(0,256)};
    }
    const target = listener.target;
    if (!target || !target.element.isConnected || Date.now() - target.at > 6000) return null;
    if (!target.ready && (!responseUrl || target.href !== responseUrl || responseAt < target.at)) return null;
    if (target.kind === "download" && target.element.href !== target.href) return null;
    listener.target = null;
    return {element: target.element, native:false, kind:target.kind, href:target.href, name:target.name ||
        (target.href === responseUrl ? responseName : null), label:target.label};
}`;

type Doc = Awaited<ReturnType<typeof publicDocument>>;
const details = v.object({
    kind: v.picklist(["upload", "download"]),
    href: v.nullable(v.string()),
    name: v.nullable(v.string()),
    label: v.string(),
    native: v.boolean(),
});

/** Track user-activated upload controls and actual same-site download links on the selected page.
 * @param grant - Fixed host-owned site and file-transfer ceiling.
 * @returns A sampler that creates a target only after a trusted click during human control.
 */
export function browserFileGestures(grant: BrowserGrant) {
    let armed:
        | {
              cdp: CDPSession;
              doc: Doc;
              epoch: string;
              context: number;
              dispose: () => void;
          }
        | undefined;
    let response: { url: string; name: string | null; time: number } | undefined;
    let chooser: { node: number; time: number } | undefined;
    const disarm = async () => {
        const old = armed;
        armed = undefined;
        response = undefined;
        chooser = undefined;
        old?.dispose();
        if (old)
            await old.cdp
                .send("Runtime.callFunctionOn", {
                    executionContextId: old.context,
                    functionDeclaration: sample,
                    arguments: [{ value: null }],
                    returnByValue: true,
                })
                .catch(() => {});
    };
    return async (cdp: CDPSession | undefined, doc: Doc | null, epoch: string | null) => {
        if (
            armed &&
            (armed.cdp !== cdp ||
                armed.epoch !== epoch ||
                doc?.loader !== armed.doc.loader ||
                doc?.url !== armed.doc.url)
        )
            await disarm();
        if (
            !epoch ||
            !cdp ||
            !doc ||
            grant.mode !== "control" ||
            (!grant.uploads && !grant.downloads)
        )
            return null;
        if (!armed) {
            const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
                frameId: doc.id,
                worldName: "mira-operator-file-controls",
            });
            const onDownload = (e: {
                frameId: string;
                url: string;
                suggestedFilename: string;
            }) => {
                if (doc.id === e.frameId)
                    response = {
                        url: e.url,
                        name: e.suggestedFilename,
                        time: Date.now(),
                    };
            };
            const onChooser = (e: { frameId: string; backendNodeId?: number }) => {
                if (doc.id === e.frameId && e.backendNodeId && grant.uploads)
                    chooser = { node: e.backendNodeId, time: Date.now() };
            };
            await cdp.send("Page.enable");
            cdp.on("Page.downloadWillBegin", onDownload);
            cdp.on("Page.fileChooserOpened", onChooser);
            armed = {
                cdp,
                doc,
                epoch,
                context: executionContextId,
                dispose: () => {
                    cdp.off("Page.downloadWillBegin", onDownload);
                    cdp.off("Page.fileChooserOpened", onChooser);
                },
            };
        }
        const signal = response && Date.now() - response.time < 6000 ? response : null;
        const clickedChooser = chooser;
        chooser = undefined;
        const chosen =
            clickedChooser && Date.now() - clickedChooser.time < 1800
                ? await cdp
                      .send("DOM.resolveNode", {
                          backendNodeId: clickedChooser.node,
                          executionContextId: armed.context,
                      })
                      .catch(() => null)
                : null;
        const group = "mira-clicked-file";
        try {
            const { result, exceptionDetails } = await cdp.send(
                "Runtime.callFunctionOn",
                {
                    executionContextId: armed.context,
                    objectGroup: group,
                    functionDeclaration: sample,
                    arguments: [
                        { value: epoch },
                        { value: Boolean(grant.uploads) },
                        { value: Boolean(grant.downloads) },
                        { value: signal?.url ?? null },
                        { value: signal?.name ?? null },
                        { value: signal?.time ?? null },
                        chosen?.object.objectId
                            ? { objectId: chosen.object.objectId }
                            : { value: null },
                        { value: clickedChooser?.time ?? null },
                    ],
                }
            );
            if (exceptionDetails || !result.objectId) return null;
            const objectId = result.objectId;
            const info = await cdp.send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration:
                    "function(){return {kind:this.kind, href:this.href, name:this.name, label:this.label, native:this.native};}",
                returnByValue: true,
            });
            const data = v.parse(details, info.result.value);
            if (data.href && new URL(data.href).origin !== new URL(doc.url).origin)
                return null;
            const element = await cdp.send("Runtime.callFunctionOn", {
                objectId,
                objectGroup: group,
                functionDeclaration: "function(){return this.element;}",
            });
            if (!element.result.objectId) return null;
            const { node } = await cdp.send("DOM.describeNode", {
                objectId: element.result.objectId,
            });
            const end = await publicDocument(cdp, grant.origins);
            if (end.loader !== doc.loader || end.url !== doc.url) return null;
            response = undefined;
            const rawName =
                data.name || (data.href && new URL(data.href).pathname.split("/").pop());
            const name =
                rawName
                    ?.split(/[\\/]/u)
                    .pop()
                    ?.replaceAll(/\p{Cc}/gu, "")
                    .trim()
                    .slice(0, 200)
                    .toWellFormed() || null;
            return { ...data, name, node: node.backendNodeId };
        } finally {
            if (chosen?.object.objectId)
                await cdp
                    .send("Runtime.releaseObject", { objectId: chosen.object.objectId })
                    .catch(() => {});
            await cdp
                .send("Runtime.releaseObjectGroup", { objectGroup: group })
                .catch(() => {});
        }
    };
}
