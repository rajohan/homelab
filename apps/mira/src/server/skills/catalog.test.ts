import { expect, test } from "bun:test";

import { miraSkillIds } from "@homelab/contracts/miraSkills";

import {
    describeMiraSkillPackages,
    readBundledMiraSkill,
    validateMiraSkillPackages,
} from "./catalog";
import bundle from "./packages.json";

test("bundled guidance exposes bounded provenance and exact passive files", () => {
    const summaries = describeMiraSkillPackages();
    expect(summaries.map((skill) => skill.id)).toEqual([...miraSkillIds]);
    for (const summary of summaries) {
        expect(summary.packageHash).toMatch(/^[a-f0-9]{64}$/);
        expect(summary).not.toHaveProperty("content");
        for (const file of summary.files) {
            const document = readBundledMiraSkill(summary.id, file.path)!;
            expect(document).toMatchObject({
                packageHash: summary.packageHash,
                sha256: file.sha256,
                version: summary.version,
            });
            expect(Buffer.byteLength(document.content)).toBe(file.bytes);
            expect(document.content).not.toMatch(/curl .*\|.*(?:sh|bash)/);
        }
    }
    summaries[0]!.sources.length = 0;
    expect(describeMiraSkillPackages()[0]!.sources.length).toBeGreaterThan(0);
    for (const path of [
        "../SKILL.md",
        "/etc/passwd",
        "https://example.test/skill.md",
        "toString",
    ])
        expect(readBundledMiraSkill("task-tracking", path)).toBeNull();
});

test("catalog rejects incomplete or duplicate packages and unsafe companion files", () => {
    expect(() => validateMiraSkillPackages(bundle.slice(1))).toThrow();
    const duplicate = validateMiraSkillPackages(bundle);
    duplicate[1] = duplicate[0]!;
    expect(() => validateMiraSkillPackages(duplicate)).toThrow();
    for (const file of [
        "../escape.md",
        "/absolute.md",
        "helpers/run.ts",
        "references/../../escape.md",
    ]) {
        const entries = validateMiraSkillPackages(bundle);
        entries[0]!.files[file] = "Untrusted companion";
        expect(() => validateMiraSkillPackages(entries)).toThrow();
    }
    const valid = validateMiraSkillPackages(bundle);
    valid[0]!.files["references/workflow.md"] = "# Reviewed companion\n";
    expect(
        Object.hasOwn(
            validateMiraSkillPackages(valid)[0]!.files,
            "references/workflow.md"
        )
    ).toBe(true);
    delete valid[0]!.files["SKILL.md"];
    expect(() => validateMiraSkillPackages(valid)).toThrow();
});

test("catalog bounds UTF-8 bytes, total content and source schemes", () => {
    for (const content of ["", "a".repeat(48_001), "🧭".repeat(12_001)]) {
        const entries = validateMiraSkillPackages(bundle);
        entries[0]!.files["SKILL.md"] = content;
        expect(() => validateMiraSkillPackages(entries)).toThrow();
    }
    const total = validateMiraSkillPackages(bundle);
    for (const entry of total) entry.files["SKILL.md"] = "a".repeat(40_000);
    expect(() => validateMiraSkillPackages(total)).toThrow();
    const source = validateMiraSkillPackages(bundle);
    source[0]!.sources = ["javascript:alert(1)"];
    expect(() => validateMiraSkillPackages(source)).toThrow();
});
