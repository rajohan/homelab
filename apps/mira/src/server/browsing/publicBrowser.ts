import { writeFile } from "node:fs/promises";

import {
    miraBrowserTabCommandSchema,
    connectedBrowserScope,
    internetBrowserScope,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import {
    launch,
    TargetType,
    type Page,
    type CDPSession,
    type Target,
} from "puppeteer-core";
import * as v from "valibot";

import { publicBrowserNetwork } from "../config/environment";
import type { openNativeBrowser } from "./native";
import { browserUrl, type BrowserGrant } from "./policy";
import { publicDocument, publicInput, publicOutline } from "./publicPage";
import { browserActionSchema } from "./wire";

const width = 800,
    height = 500;

function browserNetworkMode(scope?: string) {
    if (scope === connectedBrowserScope) return "connected";
    return scope === internetBrowserScope ? "internet" : "public";
}

/** Open a fresh public-web session in the host's isolated Chromium container.
 * @param grant - Validated temporary public grant, including its input ceiling.
 * @param signal - Container lifetime; abort closes Chromium and discards all handles.
 * @returns The same bounded browser operations used by Chat and the human console.
 */
export async function openPublicBrowser(
    grant: BrowserGrant,
    signal: AbortSignal
): Promise<Awaited<ReturnType<typeof openNativeBrowser>>> {
    signal.throwIfAborted();
    if (
        !publicBrowserNetwork(browserNetworkMode(grant.origins[0])) ||
        !unrestrictedBrowserSites(grant.origins) ||
        grant.savedProfile ||
        grant.uploads ||
        grant.downloads
    )
        throw new Error(
            "Public browsing requires the isolated online container and a fresh profile."
        );
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
    const browser = await launch({
        executablePath: grant.executable,
        headless: true,
        pipe: true,
        timeout: 12_000,
        protocolTimeout: 10_000,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-extensions",
            "--disable-background-networking",
        ],
        defaultViewport: { width, height },
        signal,
    });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= browser.close());
    const retire = () => {
        void close().catch(() => {});
    };
    const tabs = new Map<string, { page: Page; cdp: CDPSession }>();
    let selected = "";
    let observation:
        | {
              id: string;
              until: number;
              loader: string;
              url: string;
              nodes: Map<string, number>;
              refs: Awaited<ReturnType<typeof publicOutline>>["refs"];
          }
        | undefined;
    try {
        const context = await browser.createBrowserContext({
            downloadBehavior: { policy: "deny" },
        });
        let opening: Set<Target> | undefined;
        context.on("targetcreated", (target) => {
            if (target.type() !== TargetType.PAGE) return;
            if (opening) opening.add(target);
            else if (![...tabs.values()].some((tab) => tab.page.target() === target))
                retire();
        });
        const current = () => {
            const tab = tabs.get(selected);
            if (!tab) throw new Error("No selected browser tab.");
            return tab;
        };
        const add = async (value: unknown) => {
            const url = browserUrl(value, sites);
            if (tabs.size >= 8) throw new Error("Close a browser tab first.");
            opening = new Set<Target>();
            const page = await context.newPage();
            page.on("dialog", (dialog) => {
                void dialog.dismiss().catch(() => {});
            });
            const id = crypto.randomUUID();
            const cdp = await page.createCDPSession();
            tabs.set(id, { page, cdp });
            const unexpected = [...opening].some((target) => target !== page.target());
            opening = undefined;
            if (unexpected || closing)
                throw new Error("An unexpected window invalidated the browser session.");
            page.once("close", () => {
                if (tabs.has(id)) retire();
            });
            selected = id;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
            await publicDocument(cdp, sites);
        };
        const observe = async (operation: AbortSignal, operator = false) => {
            operation.throwIfAborted();
            observation = undefined;
            const { page, cdp } = current();
            const doc = await publicDocument(cdp, sites);
            const { outline, refs, handles } = await publicOutline(
                cdp,
                doc.id,
                grant.mode === "control"
            );
            const data = await page.screenshot({ type: "png", encoding: "base64" });
            const items = await Promise.all(
                [...tabs].map(async ([id, tab]) => {
                    const title = await tab.page.title();
                    return {
                        id,
                        url: browserUrl(tab.page.url(), sites),
                        title: title.slice(0, 2048),
                    };
                })
            );
            const end = await publicDocument(cdp, sites);
            operation.throwIfAborted();
            if (end.loader !== doc.loader || end.url !== doc.url)
                throw new Error("The browser document changed during observation.");
            const observationId = crypto.randomUUID();
            observation = {
                id: observationId,
                until: performance.now() + (operator ? 60_000 : 10_000),
                loader: doc.loader,
                url: doc.url,
                nodes: handles,
                refs,
            };
            return {
                observationId,
                url: doc.url,
                title: items.find((item) => item.id === selected)!.title,
                outline,
                complete: false,
                refs,
                width,
                height,
                tabs: { selectedId: selected, items },
                content: {
                    content: [
                        { type: "image" as const, mediaType: "image/png" as const, data },
                    ],
                },
            };
        };
        await add(grant.initialUrl);
        return {
            close,
            observe,
            tabs: async (input, operation, operator) => {
                operation.throwIfAborted();
                observation = undefined;
                const cmd = v.parse(miraBrowserTabCommandSchema, input);
                if (cmd.action === "open") await add(cmd.url);
                else if (cmd.action === "select" || cmd.action === "close") {
                    const tab = tabs.get(cmd.tabId);
                    if (!tab) throw new Error("Unknown browser tab.");
                    if (cmd.action === "select") selected = cmd.tabId;
                    else {
                        if (tabs.size === 1)
                            throw new Error("Keep one browser tab open.");
                        tabs.delete(cmd.tabId);
                        await tab.page.close();
                        if (selected === cmd.tabId) selected = tabs.keys().next().value!;
                    }
                }
                return observe(operation, operator);
            },
            navigate: async (value, operation) => {
                operation.throwIfAborted();
                observation = undefined;
                const { page, cdp } = current();
                await page.goto(browserUrl(value, sites), {
                    waitUntil: "domcontentloaded",
                    timeout: 12_000,
                });
                operation.throwIfAborted();
                const document = await publicDocument(cdp, sites);
                return { url: document.url };
            },
            act: async (input, operation) => {
                operation.throwIfAborted();
                const action = v.parse(browserActionSchema, input);
                const seen = observation;
                observation = undefined;
                const { cdp } = current();
                const doc = await publicDocument(cdp, sites);
                const node = seen?.nodes.get(action.ref);
                if (
                    grant.mode !== "control" ||
                    !seen ||
                    !node ||
                    seen.id !== action.observationId ||
                    performance.now() >= seen.until ||
                    doc.loader !== seen.loader ||
                    doc.url !== seen.url ||
                    !seen.refs
                        .find((item) => item.ref === action.ref)
                        ?.actions.includes(action.action)
                )
                    throw new Error("Request a fresh observation with control access.");
                await publicInput(cdp, doc.id, node, action);
                operation.throwIfAborted();
                return { effect: "unverified" as const };
            },
            upload: () =>
                Promise.reject(new Error("Use a specific website for uploads.")),
            download: () =>
                Promise.reject(new Error("Use a specific website for downloads.")),
        };
    } catch (error) {
        await close();
        throw error;
    }
}
