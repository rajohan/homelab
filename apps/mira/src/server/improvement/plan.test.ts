import { expect, test } from "bun:test";

import { parseImprovement } from "./plan";

const commit = "a".repeat(40);
const input = {
    commit,
    title: "fix(dashboard): improve layout",
    body: "Improve a small frontend detail.",
    plan: {
        version: 1,
        commit,
        files: [
            {
                path: "apps/dashboard/src/browser/pages/Example.tsx",
                beforeSha256: null,
                content: "export const example = 1;\n",
            },
        ],
    },
};

test("automatic improvements accept exact bounded frontend replacements, new files and deletion", () => {
    expect(parseImprovement(input).plan.files).toHaveLength(1);
    const files = [
        {
            path: "packages/ui/src/components/Button/Button.tsx",
            beforeSha256: "b".repeat(64),
            content: "\uFEFFexport const changed = 2;\r\n",
        },
        {
            path: "apps/dashboard/src/browser/pages/Old.ts",
            beforeSha256: "c".repeat(64),
            content: null,
        },
    ];
    expect(
        parseImprovement({ ...input, plan: { ...input.plan, files } }).plan.files
    ).toEqual(files);
});
for (const path of [
    "apps/auth/src/browser/app.tsx",
    "apps/dashboard/src/server/app.ts",
    "packages/ui/src/features/identity/Panel.tsx",
    ".github/workflows/update.ts",
    "package.json",
    "apps/dashboard/src/browser/AGENTS.md",
    "apps/dashboard/src/browser/../server/app.ts",
    "apps/dashboard/src/browser/.git/config.ts",
])
    test(`automatic improvement refuses out-of-policy path ${path}`, () => {
        expect(() =>
            parseImprovement({
                ...input,
                plan: { ...input.plan, files: [{ ...input.plan.files[0], path }] },
            })
        ).toThrow();
    });
test("automatic improvements enforce file count, UTF-8 bytes, total size and original identity", () => {
    const file = input.plan.files[0]!;
    expect(() =>
        parseImprovement({
            ...input,
            plan: {
                ...input.plan,
                files: Array.from({ length: 11 }, (_, i) => ({
                    ...file,
                    path: `apps/dashboard/src/browser/${i}.ts`,
                })),
            },
        })
    ).toThrow();
    expect(() =>
        parseImprovement({
            ...input,
            plan: { ...input.plan, files: [{ ...file, content: "æ".repeat(32_769) }] },
        })
    ).toThrow();
    expect(() =>
        parseImprovement({
            ...input,
            plan: {
                ...input.plan,
                files: Array.from({ length: 5 }, (_, i) => ({
                    ...file,
                    path: `apps/dashboard/src/browser/${i}.ts`,
                    content: "x".repeat(60_000),
                })),
            },
        })
    ).toThrow();
    expect(() =>
        parseImprovement({ ...input, plan: { ...input.plan, commit: "b".repeat(40) } })
    ).toThrow();
    expect(() =>
        parseImprovement({
            ...input,
            plan: { ...input.plan, files: [{ ...file, beforeSha256: "invalid" }] },
        })
    ).toThrow();
    expect(() =>
        parseImprovement({
            ...input,
            plan: { ...input.plan, files: [{ ...file, content: "\0" }] },
        })
    ).toThrow();
});
