import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as v from "valibot";

import { deferRouterChunkBinding } from "../scripts/development/routerHmr";

test("defers the installed RouterCore development cycle without changing other code", async () => {
    const router = Bun.resolveSync(
        "@tanstack/react-router",
        new URL("../apps/dashboard", import.meta.url).pathname
    );
    const entry = Bun.resolveSync("@tanstack/router-core", path.dirname(router));
    const source = await Bun.file(new URL("router.js", pathToFileURL(entry))).text();
    const transformed = deferRouterChunkBinding(source);
    expect(transformed).toContain(
        "_replaceRouteChunk = (...args) => replaceRouteChunk(...args)"
    );
    expect(
        transformed.replace(
            "(...args) => replaceRouteChunk(...args)",
            "replaceRouteChunk"
        )
    ).toBe(source);
    expect(() => deferRouterChunkBinding("upstream changed")).toThrow(
        "Review the TanStack"
    );
});

test("the native React Compiler emits memoization for browser components", async () => {
    const source =
        "export function Example({ title }: { title: string }) { return <h1>{title}</h1>; }";
    const result = await Bun.build({
        entrypoints: ["/homelab-compiler-check.tsx"],
        files: { "/homelab-compiler-check.tsx": source },
        target: "browser",
        packages: "external",
        reactCompiler: true,
        reactCompilerOutputMode: "client",
    });
    expect(result.success).toBe(true);
    const output = await result.outputs[0]?.text();
    expect(output).toContain("react/compiler-runtime");
    expect(output).toContain("_c(2)");
});

const workflowStep = v.object({
    name: v.string(),
    uses: v.optional(v.string()),
    run: v.optional(v.string()),
    env: v.optional(v.record(v.string(), v.string())),
    with: v.optional(v.record(v.string(), v.unknown())),
});
const workflowJob = v.object({
    needs: v.optional(v.union([v.string(), v.array(v.string())])),
    secrets: v.optional(v.unknown()),
    env: v.optional(v.record(v.string(), v.string())),
    if: v.optional(v.string()),
    permissions: v.optional(v.record(v.string(), v.string())),
    "runs-on": v.string(),
    steps: v.array(workflowStep),
});
async function ciWorkflow() {
    const source = await Bun.file(".github/workflows/ci-verify.yml").text();
    const verification = v.parse(
        v.object({
            permissions: v.record(v.string(), v.string()),
            on: v.object({ workflow_call: v.null() }),
            jobs: v.object({ verify: workflowJob }),
        }),
        Bun.YAML.parse(source)
    );
    const caller = v.parse(
        v.object({
            permissions: v.record(v.string(), v.string()),
            jobs: v.object({
                checks: v.object({
                    uses: v.string(),
                    secrets: v.optional(v.unknown()),
                    permissions: v.record(v.string(), v.string()),
                }),
                verify: workflowJob,
                windows: workflowJob,
                coverage: workflowJob,
            }),
        }),
        Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text())
    );
    return { ...caller, verification, source: JSON.stringify(Bun.YAML.parse(source)) };
}

test("PR execution cannot share a runner or secrets with authenticated coverage upload", async () => {
    const workflow = await ciWorkflow();
    const { verify, coverage } = workflow.jobs;
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.checks.uses).toBe("./.github/workflows/ci-verify.yml");
    expect(workflow.jobs.checks.secrets).toBeUndefined();
    expect(workflow.jobs.checks.permissions).toEqual({ contents: "read" });
    expect(workflow.verification.permissions).toEqual({ contents: "read" });
    expect(workflow.verification.jobs.verify.permissions).toBeUndefined();
    expect(workflow.source).not.toMatch(
        /secrets\.|github\.token|codecov\/codecov-action/
    );
    expect(verify.needs).toEqual(["checks", "windows"]);
    expect(workflow.jobs.windows["runs-on"]).toBe("windows-latest");
    expect(workflow.jobs.windows.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.windows.secrets).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.windows)).not.toMatch(
        /secrets\.|github\.token|codecov\/codecov-action/
    );
    expect(
        workflow.jobs.windows.steps.find((step) =>
            step.uses?.startsWith("actions/checkout@")
        )?.with?.["persist-credentials"]
    ).toBe(false);
    expect(verify.if).toBe("always()");
    expect(verify.steps).toEqual([
        {
            name: "Require successful source verification",
            env: {
                CHECK_RESULT: "${{ needs.checks.result }}",
                WINDOWS_RESULT: "${{ needs.windows.result }}",
            },
            run: 'test "$CHECK_RESULT" = success && test "$WINDOWS_RESULT" = success',
        },
    ]);
    expect(coverage.needs).toBe("verify");
    expect(coverage["runs-on"]).toBe("ubuntu-latest");
    expect(coverage.permissions).toEqual({ contents: "read" });
    expect(
        coverage.steps.filter((step) => step.uses).map((step) => step.uses!.split("@")[0])
    ).toEqual([
        "actions/checkout",
        "actions/download-artifact",
        "codecov/codecov-action",
    ]);
    const checkout = coverage.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@")
    )!;
    expect(checkout.with?.ref).toBe(
        "${{ github.event.pull_request.base.sha || github.sha }}"
    );
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const download = coverage.steps.find((step) =>
        step.uses?.startsWith("actions/download-artifact@")
    )!;
    expect(download.with?.path).toBe("${{ runner.temp }}/coverage-input");
    const upload = coverage.steps.find((step) =>
        step.uses?.startsWith("codecov/codecov-action@")
    )!;
    expect(upload.env).toEqual({ CODECOV_TOKEN: "${{ secrets.CODECOV_TOKEN }}" });
    expect(upload.with).toMatchObject({
        files: "${{ runner.temp }}/coverage-validated/lcov.info",
        override_commit: "${{ github.event.pull_request.head.sha || github.sha }}",
        override_pr: "${{ github.event.pull_request.number }}",
        disable_search: true,
        disable_file_fixes: true,
        plugins: "noop",
        fail_ci_if_error: true,
    });
    expect(coverage.steps.filter((step) => step.run)).toHaveLength(1);
});

test.each(["valid", "extra", "symlink", "directory", "large", "invalid-utf8", "empty"])(
    "the isolated coverage boundary accepts only passive bounded data: %s",
    async (variant) => {
        const { jobs } = await ciWorkflow();
        const script = jobs.coverage.steps.find((step) => step.run)?.run;
        expect(script).toContain("python3 -I -");
        const directory = mkdtempSync(path.join(tmpdir(), "homelab-coverage-boundary-"));
        try {
            const input = path.join(directory, "input");
            const output = path.join(directory, "validated");
            mkdirSync(input);
            const report = path.join(input, "lcov.info");
            const content =
                "TN:\nSF:apps/dashboard/src/browser/example.tsx\nDA:1,1\nend_of_record\n";
            if (variant === "symlink") {
                writeFileSync(path.join(directory, "canary"), "synthetic private data");
                symlinkSync(path.join(directory, "canary"), report);
            } else if (variant === "directory") mkdirSync(report);
            else {
                writeFileSync(
                    report,
                    variant === "invalid-utf8" ? Buffer.from([255]) : content
                );
                if (variant === "large") truncateSync(report, 32 * 1024 * 1024 + 1);
                if (variant === "empty") truncateSync(report, 0);
            }
            if (variant === "extra") {
                mkdirSync(path.join(input, ".github"));
                writeFileSync(
                    path.join(input, ".github", "injected.py"),
                    "raise Exception('must not execute')"
                );
            }
            const result = Bun.spawnSync(["bash", "-euc", script!], {
                cwd: directory,
                env: {
                    PATH: process.env.PATH ?? "/usr/bin:/bin",
                    COVERAGE_INPUT: input,
                    COVERAGE_OUTPUT: output,
                },
            });
            if (variant === "valid") {
                expect(result.exitCode).toBe(0);
                expect(readFileSync(path.join(output, "lcov.info"), "utf8")).toBe(
                    content
                );
            } else {
                expect(result.exitCode).not.toBe(0);
                expect(await Bun.file(path.join(output, "lcov.info")).exists()).toBe(
                    false
                );
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
);
