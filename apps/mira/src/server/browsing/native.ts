import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type * as NativeSdk from "@trycua/cua-driver";
import * as v from "valibot";

import { computerDriverVersion } from "../computer/policy";
import { browserGrant, browserManifest, browserUrl } from "./policy";
import { prepareBrowserProfileShutdown } from "./profileShutdown";
import {
    bindingSchema,
    browserMetadata,
    browserSnapshot,
    preparedSchema,
    windowsSchema,
} from "./protocol";
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
 * Open one fresh, isolated browser and retain the only selected tab internally.
 * @param input - Host-owned executable, origin ceiling, initial URL and input permission.
 * @param signal - Owner cancellation for the entire lifetime, including startup.
 * @param loadSdk - Pinned native SDK loader; synthetic replacement is for unit tests only.
 * @param now - Monotonic clock for observation, idle and total lifetime deadlines.
 * @returns A serialized browser port. The host must supervise its process and await close.
 */
export async function openNativeBrowser(
    input: unknown,
    signal: AbortSignal,
    loadSdk: () => Promise<typeof NativeSdk> = () => import("@trycua/cua-driver"),
    now: () => number = () => performance.now()
) {
    signal.throwIfAborted();
    const grant = browserGrant(input);
    if ((await realpath(grant.executable)) !== grant.executable)
        throw new Error("Browser executable must use its canonical path.");
    const sdk = await loadSdk();
    const directory = await mkdtemp(path.join(os.tmpdir(), "homelab-browser-"));
    const stop = new AbortController();
    const started = now();
    let touched = started;
    let busy = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let driver: ReturnType<typeof sdk.CuaDriver.createConfigured> | undefined;
    let saveProfile: (() => Promise<void>) | undefined;
    let target: { targetId: string; tabId: string; origins: string[] };
    let observed:
        | {
              id: string;
              time: number;
              refs: Map<string, ("click" | "type")[]>;
              maxAge: number;
          }
        | undefined;
    const session = randomUUID();
    const close = () => {
        closed = true;
        observed = undefined;
        stop.abort();
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        closing ??= (async () => {
            try {
                if (driver) {
                    try {
                        await saveProfile?.().catch(() => {});
                        await driver.shutdown();
                    } finally {
                        if (sdk.CuaDriver.instanceOf(driver)) driver.uniffiDestroy();
                    }
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
            | "browser_type",
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
        const result = await driver!.callTool(
            name,
            JSON.stringify({ ...args, session }),
            { signal: combined }
        );
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
    try {
        const manifest = path.join(directory, "capabilities.json");
        await writeFile(manifest, JSON.stringify(browserManifest(grant)), {
            mode: 0o600,
        });
        check(signal);
        driver = sdk.CuaDriver.createConfigured({
            claudeCodeCompatibility: false,
            authorization: {
                allowedModes: [sdk.SessionPermissionMode.Bounded],
                compatibilityMode: sdk.SessionPermissionMode.Bounded,
                compatibilityCapabilityManifestPath: manifest,
                unrestrictedAcknowledged: false,
                maxSessionTtlSeconds: 300n,
                maxIdleTtlSeconds: 60n,
            },
        });
        armTimer();
        const metadata = await driver.metadata();
        if (metadata.driverVersion !== computerDriverVersion || !metadata.embedded)
            throw new Error("Unexpected browser driver version or execution mode.");
        check(signal);
        await driver.startSession(
            { session },
            {
                signal: AbortSignal.any([
                    signal,
                    stop.signal,
                    AbortSignal.timeout(10_000),
                ]),
            }
        );
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
                        target
                    );
                    const id = randomUUID();
                    observed = {
                        id,
                        time: now(),
                        maxAge: operator ? 60_000 : 10_000,
                        refs: new Map(frame.refs.map((item) => [item.ref, item.actions])),
                    };
                    return { observationId: id, ...frame };
                }),
            navigate: (url: unknown, operation: AbortSignal) =>
                run(operation, async () => {
                    observed = undefined;
                    return navigate(browserUrl(url, grant.origins), operation);
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
