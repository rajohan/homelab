import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import type { MiraReport } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ReportDetail as SourceReport } from "./ReportDetail";

const compiledPath = `${import.meta.dir}/.ReportDetail-${crypto.randomUUID()}.js`;
let CompiledReport: typeof SourceReport;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/ReportDetail.tsx`],
        target: "bun",
        reactCompiler: true,
        reactCompilerOutputMode: "client",
        external: ["*"],
    });
    if (!build.success || !build.outputs[0])
        throw new Error("The compiled report fixture could not build.");
    await Bun.write(compiledPath, build.outputs[0]);
    ({ ReportDetail: CompiledReport } = (await import(compiledPath)) as {
        ReportDetail: typeof SourceReport;
    });
});

afterAll(async () => {
    await unlink(compiledPath).catch(() => {});
});

test.each([
    ["source", "loaded"],
    ["source", "failed"],
    ["compiled", "loaded"],
    ["compiled", "failed"],
] as const)("%s report survives pending-to-%s", async (mode, outcome) => {
    const Report = mode === "compiled" ? CompiledReport : SourceReport;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const identity = new IdentityClient();
    const id = crypto.randomUUID();
    const key = ["operations", "mira", "report", id];
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <Report id={id} onClose={() => {}} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(
            await screen.findByRole("status", { name: "Loading report…" })
        ).toBeVisible();
        expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
        act(() => {
            if (outcome === "failed") {
                query
                    .getQueryCache()
                    .find({ queryKey: key })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic report failure"),
                    });
            } else {
                query.setQueryData(key, {
                    id,
                    version: 1,
                    title: "Synthetic brief",
                    kind: "brief",
                    markdown: "The synthetic report loaded successfully.",
                    taskId: null,
                    runId: null,
                    archivedAt: null,
                    createdAt: "2026-10-31T10:00:00.000Z",
                    source: "automation",
                    outcome: "completed",
                    automationId: null,
                    conversationId: null,
                    deleted: false,
                } satisfies MiraReport & { deleted: boolean });
            }
        });
        if (outcome === "failed") {
            expect(await screen.findByRole("alert")).toHaveTextContent(
                "Synthetic report failure"
            );
            expect(
                screen.queryByRole("button", { name: "Delete" })
            ).not.toBeInTheDocument();
        } else {
            expect(
                await screen.findByRole("dialog", { name: "Synthetic brief" })
            ).toBeVisible();
            expect(
                screen.getByText("The synthetic report loaded successfully.")
            ).toBeVisible();
            expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
        }
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});
