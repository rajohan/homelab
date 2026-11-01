import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { miraBrowserTabCommandSchema } from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

import { createBrowserDownloads } from "./download";
import {
    openBrowserDriver,
    type BrowserDriver,
    type BrowserDriverFactory,
} from "./driver";
import { browserGrant, browserManifest, browserUrl } from "./policy";
import { prepareBrowserProfileShutdown } from "./profileShutdown";
import {
    bindingSchema,
    browserMetadata,
    browserSnapshot,
    preparedSchema,
    windowsSchema,
    tabBindingSchema,
} from "./protocol";
import { openBrowserTabLifecycle } from "./tabLifecycle";
import {
    browserUploadActionSchema,
    createBrowserUploads,
    type BrowserUploadFile,
} from "./upload";
import { browserActionSchema } from "./wire";

const navigationSchema = v.object({
    status: v.literal("ok"),
    target_id: v.string(),
    tab_id: v.string(),
    url: v.string(),
    refs_invalidated: v.literal(true),
});
const actionSchema = v.object({
    effect: v.literal("unverifiable"),
    route: v.literal("trusted_input"),
    delivery: v.object({ mode: v.picklist(["background", "foreground"]) }),
});

/**
 * Open one isolated browser and retain driver bindings for its explicitly managed tabs.
 * @param input - Host-owned executable, origin ceiling, initial URL and input permission.
 * @param signal - Owner cancellation for the entire lifetime, including startup.
 * @param openDriver - Pinned bounded MCP driver factory; synthetic replacements are for unit tests only.
 * @param now - Monotonic clock for observation, idle and total lifetime deadlines.
 * @param openTabs - Fixed tab lifecycle factory; synthetic replacement is only for qualification.
 * @returns A serialized browser port. The host must supervise its process and await close.
 */
export async function openNativeBrowser(
    input: unknown,
    signal: AbortSignal,
    openDriver: BrowserDriverFactory = openBrowserDriver,
    now: () => number = () => performance.now(),
    openTabs = openBrowserTabLifecycle
) {
    signal.throwIfAborted();
    const grant = browserGrant(input);
    if ((await realpath(grant.executable)) !== grant.executable)
        throw new Error("Browser executable must use its canonical path.");
    const directory = await mkdtemp(path.join(os.tmpdir(), "homelab-browser-"));
    const stop = new AbortController();
    const started = now();
    let touched = started;
    let busy = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let driver: BrowserDriver | undefined;
    let opening: Promise<BrowserDriver> | undefined;
    let saveProfile: (() => Promise<void>) | undefined;
    let downloads: Awaited<ReturnType<typeof createBrowserDownloads>> | undefined;
    let uploads: Awaited<ReturnType<typeof createBrowserUploads>> | undefined;
    let target: { targetId: string; tabId: string; origins: string[] };
    let pid: number, windowId: number;
    let lifecycle: Awaited<ReturnType<typeof openTabs>> | undefined;
    const tabs = new Map<
        string,
        { nativeId: string; target: typeof target; url: string; title: string }
    >();
    let selectedId = randomUUID() as string;
    let observed:
        | {
              id: string;
              time: number;
              refs: Map<string, ("click" | "type" | "upload")[]>;
              maxAge: number;
              downloads: Set<string>;
          }
        | undefined;
    const close = () => {
        closed = true;
        observed = undefined;
        stop.abort();
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        closing ??= (async () => {
            try {
                const active = driver ?? (await opening?.catch(() => null));
                if (active) {
                    await saveProfile?.().catch(() => {});
                    await active.shutdown();
                }
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        })();
        return closing;
    };
    const onAbort = () => {
        void close().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const check = (operation: AbortSignal) => {
        operation.throwIfAborted();
        signal.throwIfAborted();
        const time = now();
        if (
            closed ||
            time < touched ||
            time - started >= 300_000 ||
            time - touched >= 60_000
        )
            throw new Error("Browser session is stopped or expired.");
    };
    const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(
            onAbort,
            Math.max(0, Math.min(300_000 - (now() - started), 60_000))
        );
        timer.unref();
    };
    const call = async (
        name:
            | "browser_prepare"
            | "list_windows"
            | "get_browser_state"
            | "browser_navigate"
            | "browser_click"
            | "browser_set_input_files"
            | "browser_type"
            | "browser_download",
        args: Record<string, unknown>,
        operation: AbortSignal
    ) => {
        const combined = AbortSignal.any([
            signal,
            stop.signal,
            operation,
            AbortSignal.timeout(10_000),
        ]);
        check(combined);
        const result = await driver!.callTool(name, args, combined);
        check(combined);
        return result;
    };
    const tabArgs = () => ({ target_id: target.targetId, tab_id: target.tabId });
    const navigate = async (url: string, operation: AbortSignal) => {
        const data = v.parse(
            navigationSchema,
            browserMetadata(
                await call("browser_navigate", { ...tabArgs(), url }, operation)
            )
        );
        if (data.target_id !== target.targetId || data.tab_id !== target.tabId)
            throw new Error("Browser navigation returned a different tab.");
        return { url: browserUrl(data.url, grant.origins) };
    };
    const run = async <T>(operation: AbortSignal, work: () => Promise<T>) => {
        if (closed) throw new Error("Browser session is stopped.");
        if (busy) throw new Error("Browser session already has an active call.");
        busy = true;
        try {
            check(operation);
            if (lifecycle) await inventory(operation);
            const value = await work();
            check(operation);
            touched = now();
            armTimer();
            return value;
        } catch (error) {
            await close();
            throw error;
        } finally {
            busy = false;
        }
    };
    const snapshot = async (operation: AbortSignal, operator = false) => {
        observed = undefined;
        const frame = browserSnapshot(
            await call(
                "get_browser_state",
                {
                    ...tabArgs(),
                    snapshot_format: "semantic_v2",
                    include_screenshot: true,
                },
                operation
            ),
            target,
            Boolean(uploads)
        );
        const id = randomUUID();
        observed = {
            id,
            time: now(),
            maxAge: operator ? 60_000 : 10_000,
            downloads: new Set(
                operator
                    ? frame.refs
                          .filter(
                              (item) =>
                                  item.role === "link" && item.actions.includes("click")
                          )
                          .map((item) => item.ref)
                    : []
            ),
            refs: new Map(frame.refs.map((item) => [item.ref, item.actions])),
        };
        const selected = tabs.get(selectedId);
        if (selected) {
            selected.url = frame.url;
            selected.title = frame.title;
        }
        return {
            observationId: id,
            ...frame,
            ...(tabs.size > 0
                ? {
                      tabs: {
                          selectedId,
                          items: [...tabs].map(([id, tab]) => ({
                              id,
                              url: tab.url,
                              title: tab.title,
                          })),
                      },
                  }
                : {}),
        };
    };
    const inventory = async (operation: AbortSignal) => {
        const pages = await lifecycle!.pages(operation);
        if (
            pages.length !== tabs.size ||
            pages.some(
                (page) =>
                    ![...tabs.values()].some((tab) => tab.nativeId === page.targetId)
            )
        )
            throw new Error(
                "Browser tabs changed outside this session. Reopen browser access."
            );
        for (const page of pages) browserUrl(page.url, grant.origins);
        return pages;
    };
    try {
        if (grant.uploads) uploads = await createBrowserUploads(directory);
        if (grant.downloads) downloads = await createBrowserDownloads(directory);
        const manifest = path.join(directory, "capabilities.json");
        await writeFile(
            manifest,
            JSON.stringify(browserManifest(grant, uploads?.root, downloads?.root)),
            {
                mode: 0o600,
            }
        );
        check(signal);
        armTimer();
        opening = openDriver(manifest, directory, signal);
        driver = await opening;
        check(signal);
        const prepared = v.parse(
            preparedSchema,
            browserMetadata(
                await call(
                    "browser_prepare",
                    {
                        allow_launch: true,
                        profile: grant.savedProfile
                            ? { mode: "isolated_named", name: "saved" }
                            : { mode: "isolated_new" },
                    },
                    signal
                )
            )
        );
        if (prepared.endpoint_ownership.owner_pid !== prepared.prepared_pid)
            throw new Error("The browser process ownership could not be verified.");
        if (
            prepared.lifecycle.profile_persists_after_session !==
            Boolean(grant.savedProfile)
        )
            throw new Error(
                "The browser profile lifetime differs from the approved policy."
            );
        if (grant.savedProfile)
            saveProfile = await prepareBrowserProfileShutdown(prepared.prepared_pid);
        const windows = v.parse(
            windowsSchema,
            browserMetadata(
                await call("list_windows", { pid: prepared.prepared_pid }, signal)
            )
        );
        const window = windows.windows[0]!;
        pid = prepared.prepared_pid;
        windowId = window.window_id;
        if (window.pid !== prepared.prepared_pid)
            throw new Error("The browser window belongs to a different process.");
        const binding = v.parse(
            bindingSchema,
            browserMetadata(
                await call(
                    "get_browser_state",
                    { pid: prepared.prepared_pid, window_id: window.window_id },
                    signal
                )
            )
        );
        target = {
            targetId: binding.target_id,
            tabId: binding.tabs[0]!.tab_id,
            origins: grant.origins,
        };
        await navigate(browserUrl(grant.initialUrl, grant.origins), signal);
        touched = now();
        armTimer();
        return {
            observe: (operation: AbortSignal, operator = false) =>
                run(operation, async () => {
                    return snapshot(operation, operator);
                }),
            tabs: (input: unknown, operation: AbortSignal, operator = false) =>
                run(operation, async () => {
                    observed = undefined;
                    const command = v.parse(miraBrowserTabCommandSchema, input);
                    if (command.action === "open") browserUrl(command.url, grant.origins);
                    if (!lifecycle) {
                        lifecycle = await openTabs(
                            pid,
                            AbortSignal.any([signal, stop.signal])
                        );
                        const pages = await lifecycle.pages(operation);
                        if (pages.length !== 1)
                            throw new Error("Browser must start with one owned tab.");
                        tabs.set(selectedId, {
                            nativeId: pages[0]!.targetId,
                            target,
                            url: browserUrl(pages[0]!.url, grant.origins),
                            title: "",
                        });
                    }
                    await inventory(operation);
                    if (command.action === "open") {
                        if (tabs.size >= 8)
                            throw new Error(
                                "Close a tab before opening another (maximum eight)."
                            );
                        const nativeId = await lifecycle.create(operation);
                        // Existing driver bindings remain valid. Bind only the new blank tab:
                        // duplicate destination URLs never participate in identity matching.
                        const pages = await lifecycle.pages(operation);
                        if (
                            pages.length !== tabs.size + 1 ||
                            pages.filter((p) => p.url === "about:blank").length !== 1 ||
                            !pages.some(
                                (p) => p.targetId === nativeId && p.url === "about:blank"
                            ) ||
                            pages.some(
                                (p) =>
                                    p.targetId !== nativeId &&
                                    ![...tabs.values()].some(
                                        (t) => t.nativeId === p.targetId
                                    )
                            )
                        )
                            throw new Error(
                                "The new browser tab could not be identified."
                            );
                        const binding = v.parse(
                            tabBindingSchema,
                            browserMetadata(
                                await call(
                                    "get_browser_state",
                                    { pid, window_id: windowId },
                                    operation
                                )
                            )
                        );
                        const blank = binding.tabs.filter(
                            (tab) => tab.url === "about:blank"
                        );
                        if (binding.tabs.length !== pages.length || blank.length !== 1)
                            throw new Error("Browser tab binding is ambiguous.");
                        selectedId = randomUUID();
                        target = {
                            targetId: binding.target_id,
                            tabId: blank[0]!.tab_id,
                            origins: grant.origins,
                        };
                        const destination = browserUrl(command.url, grant.origins);
                        tabs.set(selectedId, {
                            nativeId,
                            target,
                            url: destination,
                            title: "",
                        });
                        await navigate(destination, operation);
                    } else if (
                        command.action === "select" ||
                        command.action === "close"
                    ) {
                        const tab = tabs.get(command.tabId);
                        if (!tab)
                            throw new Error(
                                "Choose a tab from the current browser observation."
                            );
                        if (command.action === "select") {
                            selectedId = command.tabId;
                            target = tab.target;
                        } else {
                            if (tabs.size === 1)
                                throw new Error(
                                    "Keep one browser tab open, or stop browser access."
                                );
                            await lifecycle.close(tab.nativeId, operation);
                            tabs.delete(command.tabId);
                            if (selectedId === command.tabId) {
                                selectedId = tabs.keys().next().value!;
                                target = tabs.get(selectedId)!.target;
                            }
                        }
                    }
                    return snapshot(operation, operator);
                }),
            navigate: (url: unknown, operation: AbortSignal) =>
                run(operation, async () => {
                    observed = undefined;
                    return navigate(browserUrl(url, grant.origins), operation);
                }),
            download: (command: unknown, operation: AbortSignal) =>
                run(operation, async () => {
                    const previous = observed;
                    observed = undefined;
                    const action = v.parse(browserUploadActionSchema, command);
                    if (
                        !downloads ||
                        !previous ||
                        previous.id !== action.observationId ||
                        now() - previous.time < 0 ||
                        now() - previous.time >= previous.maxAge ||
                        !previous.downloads.has(action.ref)
                    )
                        throw new Error(
                            "Browser download requires explicit authority and a fresh operator link observation."
                        );
                    const result = await call(
                        "browser_download",
                        {
                            ...tabArgs(),
                            ref: action.ref,
                            destination_root: downloads.root,
                        },
                        operation
                    );
                    if (result.images.length > 0)
                        throw new Error("Unexpected browser download images.");
                    return downloads.collect(
                        browserMetadata(result),
                        AbortSignal.any([signal, stop.signal, operation])
                    );
                }),
            upload: (command: unknown, file: BrowserUploadFile, operation: AbortSignal) =>
                run(operation, async () => {
                    const previous = observed;
                    observed = undefined;
                    const action = v.parse(browserUploadActionSchema, command);
                    if (
                        !uploads ||
                        !previous ||
                        previous.id !== action.observationId ||
                        now() - previous.time < 0 ||
                        now() - previous.time >= previous.maxAge ||
                        !previous.refs.get(action.ref)?.includes("upload")
                    )
                        throw new Error(
                            "Browser upload requires explicit authority and a fresh file-input observation."
                        );
                    const destination = await uploads.stage(
                        file,
                        AbortSignal.any([signal, stop.signal, operation])
                    );
                    // Staging consumes observation lifetime too. The native driver then re-attests
                    // the live origin and exact file node under its mutation lock.
                    if (
                        now() - previous.time < 0 ||
                        now() - previous.time >= previous.maxAge
                    )
                        throw new Error(
                            "Browser upload observation expired while staging."
                        );
                    const result = await call(
                        "browser_set_input_files",
                        {
                            ...tabArgs(),
                            ref: action.ref,
                            files: [destination],
                        },
                        operation
                    );
                    const data = v.parse(
                        v.object({
                            status: v.literal("ok"),
                            target_id: v.string(),
                            tab_id: v.string(),
                            ref: v.string(),
                            frame: v.literal("main"),
                            file_count: v.literal(1),
                        }),
                        browserMetadata(result)
                    );
                    if (
                        result.images.length > 0 ||
                        data.target_id !== target.targetId ||
                        data.tab_id !== target.tabId ||
                        data.ref !== action.ref
                    )
                        throw new Error(
                            "Browser upload returned a different destination."
                        );
                    return { effect: "unverified" as const };
                }),
            act: (command: unknown, operation: AbortSignal) =>
                run(operation, async () => {
                    const previous = observed;
                    observed = undefined;
                    const action = v.parse(browserActionSchema, command);
                    if (grant.mode === "view")
                        throw new Error("Browser access is view-only.");
                    if (
                        !previous ||
                        previous.id !== action.observationId ||
                        now() - previous.time < 0 ||
                        now() - previous.time >= previous.maxAge ||
                        !previous.refs.get(action.ref)?.includes(action.action)
                    )
                        throw new Error(
                            "Read a fresh browser observation before sending input."
                        );
                    // Native dispatch re-attests the live tab/origin and reference. Do not take
                    // another snapshot here: it would invalidate the user's observed refs.
                    const result = await call(
                        action.action === "click" ? "browser_click" : "browser_type",
                        {
                            ...tabArgs(),
                            ref: action.ref,
                            ...(action.action === "click"
                                ? { input_route: "trusted", delivery_mode: "foreground" }
                                : {
                                      text: action.text,
                                      replace: action.replace,
                                      mode: "insert_text",
                                  }),
                        },
                        operation
                    );
                    const data = v.parse(actionSchema, browserMetadata(result));
                    if (
                        result.images.length > 0 ||
                        data.delivery.mode !==
                            (action.action === "click" ? "foreground" : "background")
                    )
                        throw new Error(
                            "Browser input returned an unexpected delivery route."
                        );
                    // Delivery does not establish the application's resulting state. The next
                    // observation (or independent fixture) must verify any claimed outcome.
                    return { effect: "unverified" as const };
                }),
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
