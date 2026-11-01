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
    name: v.optional(v.string()),
    if: v.optional(v.string()),
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
                native: workflowJob,
                windows: workflowJob,
                browser: workflowJob,
                "windows-consent-acceptance": workflowJob,
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
    expect(verify.needs).toEqual([
        "platforms",
        "checks",
        "native",
        "windows",
        "windows-consent-acceptance",
        "browser",
    ]);
    for (const job of [
        workflow.jobs.windows,
        workflow.jobs["windows-consent-acceptance"],
    ]) {
        expect(job["runs-on"]).toBe("windows-latest");
        expect(job.permissions).toEqual({ contents: "read" });
        expect(job.secrets).toBeUndefined();
        expect(JSON.stringify(job)).not.toMatch(
            /secrets\.|github\.token|codecov\/codecov-action/
        );
        expect(
            job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.[
                "persist-credentials"
            ]
        ).toBe(false);
    }
    const browser = workflow.jobs.browser;
    expect(browser["runs-on"]).toBe("ubuntu-latest");
    expect(browser.permissions).toEqual({ contents: "read" });
    expect(browser.secrets).toBeUndefined();
    expect(JSON.stringify(browser)).not.toMatch(
        /secrets\.|github\.token|codecov\/codecov-action/
    );
    expect(
        browser.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.[
            "persist-credentials"
        ]
    ).toBe(false);
    expect(browser.steps.some((step) => step.run === "bash scripts/testBrowser.sh")).toBe(
        true
    );
    const runtimeTest = browser.steps.findIndex(
        (step) =>
            step.run ===
            "bun --no-env-file apps/mira/src/server/testing/browserImageSmoke.ts homelab-browser/runtime:tested"
    );
    const save = browser.steps.findIndex(
        (step) =>
            step.run ===
            "docker save --output browser-images.tar homelab-browser/runtime:tested homelab-browser/proxy:tested"
    );
    const transfer = browser.steps.findIndex(
        (step) => step.with?.name === "tested-browser-image"
    );
    expect(runtimeTest).toBeGreaterThan(0);
    const egressTest = browser.steps.findIndex((step) =>
        step.run?.includes("python3 -I scripts/smokeBrowserEgress.py")
    );
    expect(egressTest).toBeGreaterThan(runtimeTest);
    expect(save).toBeGreaterThan(egressTest);
    expect(transfer).toBeGreaterThan(save);
    expect(browser.steps[save]?.if).toBe("github.event_name == 'release'");
    expect(browser.steps[transfer]?.if).toBe("github.event_name == 'release'");
    expect(browser.steps[transfer]?.with?.path).toBe("browser-images.tar");
    expect(verify.if).toBe("always()");
    for (const job of [
        workflow.jobs.native,
        browser,
        workflow.jobs.windows,
        workflow.jobs["windows-consent-acceptance"],
    ]) {
        expect(job.needs).toBe("platforms");
        expect(job.if).toBe("needs.platforms.outputs.required == 'true'");
        expect(job.secrets).toBeUndefined();
        expect(JSON.stringify(job)).not.toMatch(/secrets\.|github\.token/);
    }
    expect(coverage.needs).toBe("checks");
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

test("CI permits only planned platform skips and rejects failed classification or tests", async () => {
    const { jobs } = await ciWorkflow();
    const gate = jobs.verify.steps[0]!;
    expect(gate.env).toMatchObject({
        PLATFORM_RESULT: "${{ needs.platforms.result }}",
        PLATFORM_REQUIRED: "${{ needs.platforms.outputs.required }}",
        CHECK_RESULT: "${{ needs.checks.result }}",
        NATIVE_RESULT: "${{ needs.native.result }}",
        BROWSER_RESULT: "${{ needs.browser.result }}",
        WINDOWS_RESULT: "${{ needs.windows.result }}",
        CONSENT_RESULT: "${{ needs.windows-consent-acceptance.result }}",
    });
    const baseline = {
        PATH: process.env.PATH!,
        PLATFORM_RESULT: "success",
        CHECK_RESULT: "success",
        PLATFORM_REQUIRED: "true",
        NATIVE_RESULT: "success",
        BROWSER_RESULT: "success",
        WINDOWS_RESULT: "success",
        CONSENT_RESULT: "success",
    };
    const run = (overrides: Record<string, string>) =>
        Bun.spawnSync(["bash", "-euc", gate.run!], {
            env: { ...baseline, ...overrides },
        }).exitCode;
    expect(run({})).toBe(0);
    expect(
        run({
            PLATFORM_REQUIRED: "false",
            NATIVE_RESULT: "skipped",
            BROWSER_RESULT: "skipped",
            WINDOWS_RESULT: "skipped",
            CONSENT_RESULT: "skipped",
        })
    ).toBe(0);
    expect(run({ PLATFORM_REQUIRED: "" })).not.toBe(0);
    for (const name of [
        "PLATFORM_RESULT",
        "CHECK_RESULT",
        "NATIVE_RESULT",
        "BROWSER_RESULT",
        "WINDOWS_RESULT",
        "CONSENT_RESULT",
    ]) {
        for (const result of ["failure", "cancelled", "skipped", ""]) {
            expect(run({ [name]: result })).not.toBe(0);
        }
    }
});

test.each([
    ["pull_request", "docs/example.md", false],
    ["pull_request", "apps/dashboard/src/browser/example.tsx", false],
    ["pull_request", "packages/ui/src/components/example.tsx", false],
    ["pull_request", "packages/ui/src/assets/rajohan.ico", true],
    ["pull_request", "packages/contracts/src/example.ts", true],
    ["pull_request", "apps/mira/src/server/example.ts", true],
    ["pull_request", "package.json", true],
    ["pull_request", "unknown-file", true],
    ["push", "docs/example.md", true],
    ["release", "docs/example.md", true],
] as const)("platform selection handles %s: %s", async (event, changed, required) => {
    const workflow = v.parse(
        v.object({ jobs: v.object({ changes: workflowJob }) }),
        Bun.YAML.parse(await Bun.file(".github/workflows/ci-platforms.yml").text())
    );
    const script = workflow.jobs.changes.steps.find((step) => step.run)!.run!;
    const directory = mkdtempSync(path.join(tmpdir(), "homelab-ci-paths-"));
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: directory });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
    };
    try {
        git("init", "--quiet");
        git(
            "-c",
            "user.name=Mira",
            "-c",
            "user.email=mira-2026@agentmail.to",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture base"
        );
        const base = git("rev-parse", "HEAD");
        const file = path.join(directory, changed);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "fixture\n");
        git("add", "--", changed);
        git(
            "-c",
            "user.name=Mira",
            "-c",
            "user.email=mira-2026@agentmail.to",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture change"
        );
        const output = path.join(directory, "output");
        const result = Bun.spawnSync(["bash", "-euc", script], {
            cwd: directory,
            env: {
                PATH: process.env.PATH!,
                EVENT_NAME: event,
                BASE_SHA: base,
                HEAD_SHA: git("rev-parse", "HEAD"),
                GITHUB_OUTPUT: output,
            },
        });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`required=${required}\n`);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
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
