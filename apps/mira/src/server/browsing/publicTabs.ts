import {
    browserWorkspaceWarning,
    miraBrowserTabCommandSchema,
    miraBrowserWorkspaceCommandSchema,
} from "@homelab/contracts/miraBrowser";
import type { BrowserContext, CDPSession, Page } from "puppeteer-core";
import * as v from "valibot";

import { type BrowserGrant, browserUrl } from "./policy";
import { publicDocument } from "./publicPage";

async function attach(page: Page) {
    const cdp = await page.createCDPSession();
    // A native picker would expose the container filesystem to the live desktop.
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    return { page, cdp };
}

/** Track actual Chromium pages and dispatch scoped actions against stable tab identities.
 * @param context - The isolated browser context owned by this grant.
 * @param grant - Host-approved sites and input permissions.
 * @returns Page selection, passive inventory and checked navigation for both controllers.
 */
export function createBrowserTabs(context: BrowserContext, grant: BrowserGrant) {
    const sites = grant.origins;
    const tabs = new Map<string, { page: Page; cdp: CDPSession }>();
    let selected = "";
    const synchronizeTabs = async (ensurePage = true) => {
        for (const [id, tab] of tabs)
            if (tab.page.isClosed()) {
                tabs.delete(id);
                await tab.cdp.detach().catch(() => {});
            }
        for (const page of await context.pages()) {
            if ([...tabs.values()].some((tab) => tab.page === page)) continue;
            tabs.set(crypto.randomUUID(), await attach(page));
        }
        let focused: string | undefined;
        const visible: string[] = [];
        for (const [id, tab] of tabs) {
            try {
                const { frameTree } = await tab.cdp.send("Page.getFrameTree");
                const { executionContextId } = await tab.cdp.send(
                    "Page.createIsolatedWorld",
                    { frameId: frameTree.frame.id, worldName: "mira-browser-focus" }
                );
                const focus = await tab.cdp.send("Runtime.evaluate", {
                    contextId: executionContextId,
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
        // A script-opened page can close itself even when it is the last tab.
        if (ensurePage && tabs.size === 0) await add(undefined);
    };
    const current = () => {
        const tab = tabs.get(selected);
        if (!tab) throw new Error("Open a website in the browser first.");
        return { ...tab, id: selected };
    };
    const add = async (value: unknown, operator = false) => {
        const url = value === undefined ? null : browserUrl(value, sites);
        if (tabs.size >= 8) throw new Error("Close a browser tab first.");
        const page = await context.newPage();
        const id = crypto.randomUUID();
        tabs.set(id, await attach(page));
        selected = id;
        if (url) {
            if (operator) {
                await page.bringToFront();
                const result = await current().cdp.send("Page.navigate", { url });
                return result.errorText ? browserWorkspaceWarning.load : null;
            }
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        await page.bringToFront();
        if (url && !operator) await publicDocument(current().cdp, sites);
        return null;
    };
    const webUrl = (value: string) => {
        try {
            return browserUrl(value, sites);
        } catch {
            return null;
        }
    };
    const permittedEntry = (url?: string) =>
        Boolean(url && (url === "about:blank" || webUrl(url)));
    const tabInventory = async () => {
        const active = current();
        const visible = [...tabs];
        if (visible.findIndex(([id]) => id === selected) >= 8)
            visible.splice(7, 1, [selected, active]);
        const items = await Promise.all(
            visible.slice(0, 8).map(async ([id, tab]) => {
                const url = webUrl(tab.page.url());
                const title = url ? await tab.page.title().catch(() => "") : "";
                const currentUrl = webUrl(tab.page.url());
                return {
                    id,
                    url: currentUrl,
                    title:
                        currentUrl && currentUrl === url
                            ? title.slice(0, 2048).toWellFormed()
                            : "",
                };
            })
        );
        const history = await active.cdp.send("Page.getNavigationHistory");
        return {
            selectedId: selected,
            items,
            canGoBack: permittedEntry(history.entries[history.currentIndex - 1]?.url),
            canGoForward: permittedEntry(history.entries[history.currentIndex + 1]?.url),
        };
    };
    const command = async (input: unknown, operator: boolean) => {
        const cmd = v.parse(
            operator ? miraBrowserWorkspaceCommandSchema : miraBrowserTabCommandSchema,
            input
        );
        if (operator && grant.mode !== "control")
            throw new Error("Browser access is view-only.");
        await synchronizeTabs(cmd.action !== "open");
        if (cmd.action === "open") {
            if (operator && tabs.size >= 8) return browserWorkspaceWarning.limit;
            return add(cmd.url, operator);
        } else if (cmd.action === "select" || cmd.action === "close") {
            const tab = tabs.get(cmd.tabId);
            if (operator && !tab) return browserWorkspaceWarning.changed;
            if (operator && cmd.action === "close" && tabs.size === 1)
                return browserWorkspaceWarning.last;
            if (!tab) throw new Error("Unknown browser tab.");
            if (cmd.action === "select") {
                selected = cmd.tabId;
                await tab.page.bringToFront();
            } else {
                if (tabs.size === 1) throw new Error("Keep one browser tab open.");
                tabs.delete(cmd.tabId);
                await tab.page.close();
                if (selected === cmd.tabId) {
                    selected = tabs.keys().next().value!;
                    await current().page.bringToFront();
                }
            }
        } else if (cmd.action !== "list" && cmd.tabId === selected) {
            const { cdp, page } = current();
            if (cmd.action === "navigate") {
                const result = await cdp.send("Page.navigate", {
                    url: browserUrl(cmd.url, sites),
                });
                if (result.errorText) return browserWorkspaceWarning.load;
            } else if (cmd.action === "reload") {
                if (webUrl(page.url())) await cdp.send("Page.reload");
            } else {
                const history = await cdp.send("Page.getNavigationHistory");
                const entry =
                    history.entries[
                        history.currentIndex + (cmd.action === "back" ? -1 : 1)
                    ];
                if (!entry || !permittedEntry(entry.url))
                    return browserWorkspaceWarning.history;
                await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
            }
        } else if (cmd.action !== "list") return browserWorkspaceWarning.changed;
        return null;
    };
    return { current, add, synchronizeTabs, tabInventory, webUrl, command };
}
