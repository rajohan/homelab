import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { MiraAutomation } from "@homelab/contracts/mira";
import type { MiraImprovementGrant } from "@homelab/contracts/miraImprovement";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitForElementToBeRemoved } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ImprovementPermission as SourcePermission } from "./ImprovementPermission";

const compiledPath = `${import.meta.dir}/.ImprovementPermission-${crypto.randomUUID()}.js`;
let CompiledPermission: typeof SourcePermission;

beforeAll(async () => {
    // The production compiler can hoist mutation dependencies into the loading render.
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/ImprovementPermission.tsx`],
        target: "bun",
        reactCompiler: true,
        reactCompilerOutputMode: "client",
        external: ["*"],
    });
    if (!build.success || !build.outputs[0])
        throw new Error("The compiled coding permission fixture could not build.");
    await Bun.write(compiledPath, build.outputs[0]);
    ({ ImprovementPermission: CompiledPermission } = (await import(compiledPath)) as {
        ImprovementPermission: typeof SourcePermission;
    });
});

afterAll(async () => {
    await unlink(compiledPath).catch(() => {});
});

test.each([
    ["source", "available"],
    ["source", "blocked"],
    ["source", "failed"],
    ["compiled", "available"],
    ["compiled", "blocked"],
    ["compiled", "failed"],
] as const)("%s coding permission survives pending-to-%s", async (mode, outcome) => {
    const Permission = mode === "compiled" ? CompiledPermission : SourcePermission;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const identity = new IdentityClient();
    const automation = {
        id: crypto.randomUUID(),
        title: "Synthetic frontend improvement",
        version: 1,
    } as MiraAutomation;
    const key = ["operations", "mira", "improvement-grant", automation.id];
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <Permission automation={automation} onClose={() => {}} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByRole("dialog")).toHaveAccessibleName(
            "Automatic code changes"
        );
        expect(
            screen.getByRole("status", { name: "Loading coding permission…" })
        ).toBeVisible();
        expect(screen.getByRole("button", { name: "Allow code changes" })).toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Close reviewed attempt" })
        ).toBeNull();
        act(() => {
            if (outcome === "failed") {
                query
                    .getQueryCache()
                    .find({ queryKey: key })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic permission failure"),
                    });
            } else {
                query.setQueryData(key, {
                    automationId: automation.id,
                    version: 2,
                    enabled: false,
                    current: false,
                    available: outcome === "available",
                    blocked:
                        outcome === "blocked"
                            ? {
                                  id: crypto.randomUUID(),
                                  canClose: true,
                                  reason: "Review the synthetic unresolved check.",
                              }
                            : null,
                } satisfies MiraImprovementGrant);
            }
        });
        if (outcome === "failed") {
            expect(await screen.findByRole("alert")).toHaveTextContent(
                "Synthetic permission failure"
            );
            expect(
                screen.getByRole("button", { name: "Allow code changes" })
            ).toBeDisabled();
        } else if (outcome === "blocked") {
            expect(
                await screen.findByText("Review the synthetic unresolved check.")
            ).toBeVisible();
            const closeAttempt = screen.getByRole("button", {
                name: "Close reviewed attempt",
            });
            expect(closeAttempt).toBeDisabled();
            act(() => {
                query.setQueryData(key, (current: MiraImprovementGrant) => ({
                    ...current,
                    blocked: null,
                }));
            });
            await waitForElementToBeRemoved(closeAttempt);
        } else {
            expect(
                await screen.findByRole("button", { name: "Allow code changes" })
            ).toBeEnabled();
        }
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});
