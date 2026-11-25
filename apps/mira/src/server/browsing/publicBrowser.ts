import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    connectedBrowserScope,
    internetBrowserScope,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import { launch } from "puppeteer-core";
import * as v from "valibot";

import { publicBrowserNetwork } from "../config/environment";
import {
    browserDesktopClipboard,
    browserDesktopFrame,
    browserDesktopInput,
} from "./desktop";
import { type BrowserGrant, browserUrl } from "./policy";
import { browserProfileDirectory } from "./profile";
import { browserFileGestures } from "./publicFileGestures";
import { publicDocument, publicInput, publicOutline } from "./publicPage";
import { createBrowserTabs } from "./publicTabs";
import { publicDownload, publicUpload } from "./publicTransfers";
import {
    browserUploadActionSchema,
    type BrowserUploadFile,
    createBrowserUploads,
} from "./upload";
import { browserActionSchema } from "./wire";

function browserNetworkMode(scope?: string) {
    if (scope === connectedBrowserScope) return "connected";
    return scope === internetBrowserScope ? "internet" : "public";
}

/** Open a fresh public-web session in the host's isolated Chromium container.
 * @param grant - Validated temporary public grant, including its input ceiling.
 * @param signal - Container lifetime; abort closes Chromium and discards all handles.
 * @returns The same bounded browser operations used by Chat and the human console.
 */
export async function openPublicBrowser(grant: BrowserGrant, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
        !publicBrowserNetwork(browserNetworkMode(grant.origins[0])) ||
        !unrestrictedBrowserSites(grant.origins)
    )
        throw new Error("Broad browsing requires the isolated online container.");
    const sites = grant.origins;
    const policyFile = "/etc/chromium/policies/managed/mira-public.json";
    await writeFile(
        policyFile,
        JSON.stringify({
            URLBlocklist: ["*"],
            URLAllowlist: ["http://*", "https://*"],
            DownloadRestrictions: 3,
            DefaultPopupsSetting: 2,
            PasswordManagerEnabled: false,
        })
    );
    const savedDirectory = `${browserProfileDirectory}/saved`;
    if (grant.savedProfile) await mkdir(savedDirectory, { recursive: true, mode: 0o700 });
    const browser = await launch({
        ...(grant.savedProfile ? { userDataDir: savedDirectory } : {}),
        executablePath: grant.executable,
        headless: false,
        ignoreDefaultArgs: ["--enable-automation"],
        pipe: true,
        timeout: 30_000,
        protocolTimeout: 10_000,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-extensions",
            "--disable-background-networking",
            "--window-size=1280,800",
            "--start-maximized",
            "--kiosk",
        ],
        defaultViewport: null,
        signal,
    });
    let closing: Promise<void> | undefined;
    let directory: string | undefined;
    let uploads: Awaited<ReturnType<typeof createBrowserUploads>> | undefined;
    const close = () =>
        (closing ??= (async () => {
            await browser.close();
            if (directory) await rm(directory, { recursive: true, force: true });
        })());
    let observation:
        | {
              id: string;
              until: number;
              operator: boolean;
              loader: string | null;
              url: string | null;
              tabId: string;
              gesture?: {
                  id: string;
                  epoch: string;
                  href: string | null;
                  field: "label" | "chooser";
              };
              width: number;
              height: number;
              nodes: Map<string, number>;
              refs: Awaited<ReturnType<typeof publicOutline>>["refs"];
          }
        | undefined;
    try {
        if (grant.uploads) {
            directory = await mkdtemp(path.join(os.tmpdir(), "mira-public-transfer-"));
            uploads = await createBrowserUploads(directory);
        }
        const context = browser.defaultBrowserContext();
        const control = await browser.target().createCDPSession();
        await control.send("Browser.setDownloadBehavior", { behavior: "deny" });
        await control.detach();
        const initialPages = await context.pages();
        const { current, add, synchronizeTabs, tabInventory, webUrl, command } =
            createBrowserTabs(context, grant);
        const sampleFile = browserFileGestures(grant);
        let publishedFileRequest: string | null = null;
        const capture = async (
            operation: AbortSignal,
            operator: boolean,
            retry: boolean
        ) => {
            operation.throwIfAborted();
            observation = undefined;
            await synchronizeTabs();
            const { page, cdp } = current();
            const doc = webUrl(page.url()) ? await publicDocument(cdp, sites) : null;
            // The accessibility tree and tab titles can disappear on a redirect.
            // Native pixels remain useful when Chromium cannot provide element refs.
            const pageOutline = doc
                ? await publicOutline(
                      cdp,
                      doc.id,
                      grant.mode === "control",
                      operator && Boolean(grant.uploads)
                  ).catch(() => null)
                : null;
            const { outline, refs, handles } = pageOutline ?? {
                outline:
                    "Use the Chromium screenshot for native input. Website element refs are unavailable.",
                refs: [],
                handles: new Map<string, number>(),
            };
            const { data, width, height, mediaType } =
                await browserDesktopFrame(operation);
            const strip = await tabInventory();
            const selected = strip.selectedId;
            const activeTab = strip.items.find((tab) => tab.id === selected)!;
            const end = webUrl(page.url()) ? await publicDocument(cdp, sites) : null;
            operation.throwIfAborted();
            const stable =
                end?.loader === doc?.loader &&
                end?.url === doc?.url &&
                activeTab.url === (doc?.url ?? null);
            if (!stable && retry) return null;
            const observationId = crypto.randomUUID();
            if (stable)
                observation = {
                    id: observationId,
                    until: performance.now() + (operator ? 60_000 : 10_000),
                    operator,
                    loader: doc?.loader ?? null,
                    url: doc?.url ?? null,
                    tabId: selected,
                    width,
                    height,
                    nodes: handles,
                    refs,
                };
            return {
                observationId,
                url: activeTab.url,
                title: activeTab.title,
                outline: stable
                    ? outline
                    : "The page is navigating. Observe again before using input.",
                complete: false,
                refs: stable ? refs : [],
                width,
                height,
                tabs: strip,
                content: {
                    content: [{ type: "image" as const, mediaType, data }],
                },
            };
        };
        const observe = async (operation: AbortSignal, operator = false) => {
            // A navigation during a read invalidates the frame. Reacquire before
            // exposing any pixels or actionable handles. Never repeat input.
            const first = await capture(operation, operator, true);
            return first ?? (await capture(operation, operator, false))!;
        };
        const transferTarget = async (
            input: unknown,
            kind: "upload" | "download",
            operation: AbortSignal
        ) => {
            operation.throwIfAborted();
            const action = v.parse(browserUploadActionSchema, input);
            const seen = observation;
            observation = undefined;
            await synchronizeTabs();
            const { cdp } = current();
            const doc = await publicDocument(cdp, sites);
            const node = seen?.nodes.get(action.ref);
            const ref = seen?.refs.find((item) => item.ref === action.ref);
            if (
                grant.mode !== "control" ||
                !grant[kind === "upload" ? "uploads" : "downloads"] ||
                !seen?.operator ||
                current().id !== seen.tabId ||
                !node ||
                seen.id !== action.observationId ||
                performance.now() >= seen.until ||
                doc.loader !== seen.loader ||
                doc.url !== seen.url ||
                (kind === "upload"
                    ? !ref?.actions.includes("upload")
                    : ref?.role !== "link" || !ref.actions.includes("click"))
            )
                throw new Error(
                    "File transfer requires a fresh operator observation of this website."
                );
            return { cdp, doc, node, until: seen.until, gesture: seen.gesture };
        };
        await add(grant.initialUrl);
        for (const page of initialPages) await page.close();
        return {
            close,
            observe,
            fileGesture: async (epoch: string | null, operation: AbortSignal) => {
                operation.throwIfAborted();
                if (!grant.uploads && !grant.downloads) return null;
                const tab = await synchronizeTabs()
                    .then(current)
                    .catch(() => null);
                const doc =
                    tab && webUrl(tab.page.url())
                        ? await publicDocument(tab.cdp, sites).catch(() => null)
                        : null;
                const previous = observation?.gesture;
                const cleared =
                    publishedFileRequest &&
                    (!doc ||
                        previous?.id !== publishedFileRequest ||
                        previous.epoch !== epoch ||
                        !observation ||
                        observation.tabId !== tab?.id ||
                        observation.loader !== doc.loader ||
                        observation.url !== doc.url ||
                        performance.now() >= observation.until)
                        ? publishedFileRequest
                        : null;
                if (cleared) {
                    if (previous?.id === cleared) observation = undefined;
                    publishedFileRequest = null;
                }
                // Navigation can destroy the isolated context during any CDP read.
                const click = await sampleFile(tab?.cdp, doc, epoch).catch(() => null);
                if (!tab || !click || !doc || !epoch) return cleared ? { cleared } : null;
                const observationId = crypto.randomUUID();
                const ref = "p1:1";
                const fileRequest = {
                    id: crypto.randomUUID(),
                    kind: click.kind,
                    observationId,
                    ref,
                    origin: new URL(doc.url).origin,
                    label: click.label,
                    suggestedName: click.name,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                };
                const refs = [
                    {
                        ref,
                        role: click.kind === "download" ? "link" : "button",
                        label: click.label,
                        actions:
                            click.kind === "download"
                                ? ["click" as const]
                                : ["upload" as const],
                    },
                ];
                observation = {
                    id: observationId,
                    operator: true,
                    until: performance.now() + 60_000,
                    loader: doc.loader,
                    url: doc.url,
                    tabId: tab.id,
                    width: 0,
                    height: 0,
                    nodes: new Map([[ref, click.node]]),
                    refs,
                    gesture: {
                        id: fileRequest.id,
                        epoch,
                        href: click.href,
                        field: click.native ? "chooser" : "label",
                    },
                };
                publishedFileRequest = fileRequest.id;
                return { observationId, url: doc.url, title: "", refs, fileRequest };
            },
            workspace: async (operation: AbortSignal, input?: unknown) => {
                operation.throwIfAborted();
                let warning: Awaited<ReturnType<typeof command>> = null;
                if (input !== undefined) {
                    observation = undefined;
                    warning = await command(input, true);
                }
                try {
                    await synchronizeTabs();
                    return { ...(await tabInventory()), ...(warning ? { warning } : {}) };
                } catch {
                    operation.throwIfAborted();
                    // Chromium can replace a target between enumeration and inspection.
                    return null;
                }
            },
            clipboard: (input: unknown, operation: AbortSignal) => {
                observation = undefined;
                return browserDesktopClipboard(input, operation);
            },
            tabs: async (input: unknown, operation: AbortSignal, operator = false) => {
                operation.throwIfAborted();
                observation = undefined;
                await command(input, operator);
                return observe(operation, operator);
            },
            navigate: async (value: unknown, operation: AbortSignal) => {
                operation.throwIfAborted();
                observation = undefined;
                await synchronizeTabs();
                const { page, cdp } = current();
                await page.goto(browserUrl(value, sites), {
                    waitUntil: "domcontentloaded",
                    timeout: 30_000,
                });
                operation.throwIfAborted();
                const document = await publicDocument(cdp, sites);
                return { url: document.url };
            },
            act: async (input: unknown, operation: AbortSignal) => {
                operation.throwIfAborted();
                const action = v.parse(browserActionSchema, input);
                const seen = observation;
                observation = undefined;
                await synchronizeTabs();
                const { page, cdp } = current();
                const doc = webUrl(page.url()) ? await publicDocument(cdp, sites) : null;
                if (
                    grant.mode !== "control" ||
                    !seen ||
                    seen.gesture ||
                    seen.id !== action.observationId ||
                    performance.now() >= seen.until ||
                    current().id !== seen.tabId ||
                    (doc?.loader ?? null) !== seen.loader ||
                    (doc?.url ?? null) !== seen.url
                )
                    throw new Error("Request a fresh observation with control access.");
                if ("ref" in action) {
                    const node = seen.nodes.get(action.ref);
                    if (
                        !doc ||
                        !node ||
                        !seen.refs
                            .find((item) => item.ref === action.ref)
                            ?.actions.includes(action.action)
                    )
                        throw new Error(
                            "Choose an allowed element from the current observation."
                        );
                    await publicInput(cdp, doc.id, node, action);
                } else await browserDesktopInput(action, seen, operation);
                operation.throwIfAborted();
                return { effect: "unverified" as const };
            },
            upload: async (
                input: unknown,
                file: BrowserUploadFile,
                operation: AbortSignal
            ) => {
                const target = await transferTarget(input, "upload", operation);
                if (!uploads) throw new Error("Uploads are unavailable.");
                const staged = await uploads.stage(file, operation);
                const currentDocument = await publicDocument(target.cdp, sites);
                operation.throwIfAborted();
                if (
                    performance.now() >= target.until ||
                    currentDocument.loader !== target.doc.loader ||
                    currentDocument.url !== target.doc.url
                )
                    throw new Error("The upload observation changed while staging.");
                await publicUpload(
                    target.cdp,
                    target.doc.id,
                    target.node,
                    staged,
                    new URL(target.doc.url).origin,
                    target.gesture?.field
                );
                operation.throwIfAborted();
                return { effect: "unverified" as const };
            },
            download: async (input: unknown, operation: AbortSignal) => {
                const { cdp, doc, node, gesture } = await transferTarget(
                    input,
                    "download",
                    operation
                );
                return publicDownload(
                    cdp,
                    doc.id,
                    node,
                    new URL(doc.url).origin,
                    operation,
                    gesture?.href
                );
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}
