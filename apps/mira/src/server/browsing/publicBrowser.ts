import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    connectedBrowserScope,
    internetBrowserScope,
    miraBrowserTabCommandSchema,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import { type CDPSession, launch, type Page } from "puppeteer-core";
import * as v from "valibot";

import { publicBrowserNetwork } from "../config/environment";
import { browserDesktopFrame, browserDesktopInput } from "./desktop";
import { type BrowserGrant, browserUrl } from "./policy";
import { browserProfileDirectory } from "./profile";
import { publicDocument, publicInput, publicOutline } from "./publicPage";
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
    const tabs = new Map<string, { page: Page; cdp: CDPSession }>();
    let selected = "";
    let observation:
        | {
              id: string;
              until: number;
              operator: boolean;
              loader: string | null;
              url: string | null;
              tabId: string;
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
        const synchronizeTabs = async () => {
            for (const [id, tab] of tabs)
                if (tab.page.isClosed()) {
                    tabs.delete(id);
                    await tab.cdp.detach().catch(() => {});
                }
            for (const page of await context.pages()) {
                if ([...tabs.values()].some((tab) => tab.page === page)) continue;
                tabs.set(crypto.randomUUID(), {
                    page,
                    cdp: await page.createCDPSession(),
                });
            }
            let focused: string | undefined;
            const visible: string[] = [];
            for (const [id, tab] of tabs) {
                try {
                    const focus = await tab.cdp.send("Runtime.evaluate", {
                        expression:
                            "({focused: document.hasFocus(), visible: document.visibilityState === 'visible'})",
                        returnByValue: true,
                    });
                    const state = v.parse(
                        v.object({ focused: v.boolean(), visible: v.boolean() }),
                        focus.result.value
                    );
                    if (state.focused) focused = id;
                    if (state.visible) visible.push(id);
                } catch {
                    /* A closing tab is reconciled on the next observation. */
                }
            }
            if (focused) selected = focused;
            else if (!visible.includes(selected) && visible.length > 0)
                selected = visible.at(-1)!;
            if (!tabs.has(selected)) selected = tabs.keys().next().value ?? "";
        };
        const current = () => {
            const tab = tabs.get(selected);
            if (!tab) throw new Error("Open a website in the browser first.");
            return tab;
        };
        const add = async (value: unknown) => {
            const url = browserUrl(value, sites);
            if (tabs.size >= 8) throw new Error("Close a browser tab first.");
            const page = await context.newPage();
            const id = crypto.randomUUID();
            tabs.set(id, { page, cdp: await page.createCDPSession() });
            selected = id;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.bringToFront();
            await publicDocument(current().cdp, sites);
        };
        const webUrl = (value: string) => {
            try {
                return browserUrl(value, sites);
            } catch {
                return null;
            }
        };
        const observe = async (operation: AbortSignal, operator = false) => {
            operation.throwIfAborted();
            observation = undefined;
            await synchronizeTabs();
            const { page, cdp } = current();
            const doc = webUrl(page.url()) ? await publicDocument(cdp, sites) : null;
            const { outline, refs, handles } = doc
                ? await publicOutline(
                      cdp,
                      doc.id,
                      grant.mode === "control",
                      operator && Boolean(grant.uploads)
                  )
                : {
                      outline:
                          "Chromium controls or an internal page are visible. Use the screenshot for native input; no website element refs are available.",
                      refs: [],
                      handles: new Map<string, number>(),
                  };
            const { data, width, height, mediaType } =
                await browserDesktopFrame(operation);
            const visibleTabs = [
                [selected, current()] as const,
                ...[...tabs].filter(([id]) => id !== selected),
            ].slice(0, 8);
            const items = await Promise.all(
                visibleTabs.map(async ([id, tab]) => {
                    const title = await tab.page.title();
                    return {
                        id,
                        url: webUrl(tab.page.url()),
                        title: title.slice(0, 2048),
                    };
                })
            );
            const end = webUrl(page.url()) ? await publicDocument(cdp, sites) : null;
            operation.throwIfAborted();
            if (end?.loader !== doc?.loader || end?.url !== doc?.url)
                throw new Error("The browser document changed during observation.");
            const observationId = crypto.randomUUID();
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
                url: doc?.url ?? null,
                title: items.find((item) => item.id === selected)!.title,
                outline,
                complete: false,
                refs,
                width,
                height,
                tabs: { selectedId: selected, items },
                content: {
                    content: [{ type: "image" as const, mediaType, data }],
                },
            };
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
                selected !== seen.tabId ||
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
            return { cdp, doc, node, until: seen.until };
        };
        await add(grant.initialUrl);
        for (const page of initialPages) await page.close();
        return {
            close,
            observe,
            tabs: async (input: unknown, operation: AbortSignal, operator = false) => {
                operation.throwIfAborted();
                observation = undefined;
                await synchronizeTabs();
                const cmd = v.parse(miraBrowserTabCommandSchema, input);
                if (cmd.action === "open") await add(cmd.url);
                else if (cmd.action === "select" || cmd.action === "close") {
                    const tab = tabs.get(cmd.tabId);
                    if (!tab) throw new Error("Unknown browser tab.");
                    if (cmd.action === "select") {
                        selected = cmd.tabId;
                        await tab.page.bringToFront();
                    } else {
                        if (tabs.size === 1)
                            throw new Error("Keep one browser tab open.");
                        tabs.delete(cmd.tabId);
                        await tab.page.close();
                        if (selected === cmd.tabId) selected = tabs.keys().next().value!;
                    }
                }
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
                    seen.id !== action.observationId ||
                    performance.now() >= seen.until ||
                    selected !== seen.tabId ||
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
                    new URL(target.doc.url).origin
                );
                operation.throwIfAborted();
                return { effect: "unverified" as const };
            },
            download: async (input: unknown, operation: AbortSignal) => {
                const { cdp, doc, node } = await transferTarget(
                    input,
                    "download",
                    operation
                );
                return publicDownload(
                    cdp,
                    doc.id,
                    node,
                    new URL(doc.url).origin,
                    operation
                );
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}
