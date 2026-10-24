import { test, expect, spyOn } from "bun:test";
import { rejects } from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import miraPackage from "../../../package.json";
import manifest from "./systemSkills.json";
import { validatePilot } from "./validatePilot";

async function fixture(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), "homelab-mira-isolation-"));
    try {
        await mkdir(path.join(root, "home"));
        await mkdir(path.join(root, "workspace"));
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const config = (root: string) => ({
    command: process.execPath,
    codexHome: path.join(root, "home"),
    workspace: path.join(root, "workspace"),
});

test("rejects a scripted executable that could replace the intended runtime identity", async () => {
    await fixture(async (root) => {
        const wrapper = path.join(root, "wrapper");
        await writeFile(wrapper, "#!/bin/sh\nexec sudo -u other codex\n");
        await rejects(
            validatePilot({ ...config(root), command: wrapper }),
            /native Codex/
        );
    });
});

test.each(["content", ".git", "AGENTS.md", ".codex"])(
    "rejects a workspace with %s content or ancestor context",
    async (entry) => {
        await fixture(async (root) => {
            await writeFile(
                entry === "content"
                    ? path.join(root, "workspace", "file.txt")
                    : path.join(root, entry),
                "synthetic"
            );
            await rejects(validatePilot(config(root)), /workspace/);
        });
    }
);

test("rejects an existing MCP profile before launching any process", async () => {
    await fixture(async (root) => {
        await writeFile(
            path.join(root, "home", "config.toml"),
            '[mcp_servers.external]\ncommand="/bin/false"\n'
        );
        await rejects(validatePilot(config(root)), /dedicated home/);
    });
});

test.each(["modified", "extra", "symlink"])(
    "rejects a %s system-skill cache despite its marker",
    async (mode) => {
        await fixture(async (root) => {
            const directory = path.join(root, "home", "skills", ".system");
            await mkdir(directory, { recursive: true });
            await writeFile(
                path.join(directory, ".codex-system-skills.marker"),
                "matching-marker\n"
            );
            if (mode === "extra")
                await writeFile(
                    path.join(directory, "unexpected.md"),
                    "untrusted instructions"
                );
            else {
                await mkdir(path.join(directory, "skill-creator"));
                const file = path.join(directory, "skill-creator", "SKILL.md");
                await (mode === "symlink"
                    ? symlink(path.join(root, "home"), file, "junction")
                    : writeFile(file, "altered built-in skill instructions"));
            }
            await rejects(validatePilot(config(root)), /system skills/);
        });
    }
);

test("retains canonical directories when an ancestor alias is retargeted", async () => {
    await fixture(async (root) => {
        const actual = path.join(root, "actual");
        const alias = path.join(root, "alias");
        await mkdir(actual);
        await rename(path.join(root, "home"), path.join(actual, "home"));
        await rename(path.join(root, "workspace"), path.join(actual, "workspace"));
        await symlink(actual, alias, "junction");
        const probe = Bun.spawnSync({ cmd: [process.execPath, "--version"] });
        const version = spyOn(Bun, "spawnSync").mockReturnValue({
            ...probe,
            stdout: Buffer.from(`codex-cli ${manifest.version}\n`),
        });
        let checked;
        try {
            checked = await validatePilot(config(alias));
        } finally {
            version.mockRestore();
        }
        expect(checked.codexHome).toBe(await realpath(path.join(actual, "home")));
        expect(checked.workspace).toBe(await realpath(path.join(actual, "workspace")));
        await rm(alias);
        await symlink(root, alias, "junction");
        expect(checked.workspace).toBe(path.join(await realpath(actual), "workspace"));
        await rejects(
            validatePilot({
                ...config(actual),
                workspace: path.join(alias, "actual", "home"),
            }),
            /separate directories/
        );
    });
});

test("system skill manifest tracks the pinned Codex dependency", () => {
    expect(manifest.version).toBe(miraPackage.dependencies["@openai/codex"]);
});

test("rejects an unrelated native executable instead of qualifying an unpinned runtime", async () => {
    await fixture(async (root) => {
        await rejects(validatePilot(config(root)), /pinned Codex/);
    });
});
