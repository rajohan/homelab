import assert from "node:assert/strict";

import { browserDockerRequest } from "../browsing/docker";
import {
    cleanupLocalCodeContainer,
    executeLocalCodeCheck,
    localCodeContainerSpec,
    type LocalCodeJournal,
} from "../sandbox/localContainer";
import type { LocalCheckInput } from "../sandbox/localProtocol";

/**
 * Qualify actual local Docker input, output, cancellation and restart cleanup using the shared image.
 * @returns Completion after every container is confirmed absent; no provider credits or private data are used.
 */
export async function main(): Promise<void> {
    const [file, commit, mode] = process.argv.slice(2);
    assert.ok(file && commit && /^[a-f0-9]{40}$/.test(commit));
    assert.ok(mode === undefined || mode === "--full");
    const config: unknown = await Bun.file(file).json();
    const { localCodeConfigurationSchema } = await import("../sandbox/localContainer");
    const { parse } = await import("valibot");
    const validated = parse(localCodeConfigurationSchema, config);
    assert.ok(validated.egress, "Actual qualification requires the isolated proxy.");
    const call = browserDockerRequest(validated.socketPath);
    const controller = new AbortController();
    const journal = () => {
        let receipt: string | undefined,
            confirmed = false;
        const record: LocalCodeJournal = {
            creating: () => Promise.resolve(),
            created: async (id) => {
                receipt = id;
                const inspected = await call("GET", `/containers/${id}/json`);
                assert.equal(inspected.status, 200);
                const { object, array, literal, string } = await import("valibot");
                parse(
                    object({
                        Mounts: array(
                            object({ Type: literal("tmpfs"), Destination: string() })
                        ),
                    }),
                    inspected.body
                );
            },
            rejected: () => Promise.resolve(),
            starting: () => Promise.resolve(),
            cleaning: () => Promise.resolve(),
            discovered: (id) => {
                receipt = id;
                return Promise.resolve();
            },
            cleaned: () => {
                confirmed = true;
                return Promise.resolve();
            },
        };
        return {
            record,
            absent: async () => {
                assert.ok(confirmed && receipt);
                const removed = await call("GET", `/containers/${receipt}/json`);
                assert.equal(removed.status, 404);
            },
        };
    };
    const source = journal();
    const inspected = await executeLocalCodeCheck(
        config,
        {
            request: {
                id: crypto.randomUUID(),
                commit,
                paths: [".bun-version", "AGENTS.md"],
            },
            input: null,
        },
        source.record,
        controller.signal
    );
    assert.equal(inspected.exitCode, 0);
    const files = inspected.files.find((item) => item.name === "source-files.json");
    assert.ok(files?.text.includes("1.4.4"));
    await source.absent();

    const text =
        mode === "--full"
            ? JSON.stringify({
                  version: 1,
                  commit,
                  files: [
                      {
                          path: "docs/local-check-smoke.txt",
                          beforeSha256: null,
                          content: "Local code check qualification.\n",
                      },
                  ],
              })
            : "Invalid patch qualification";
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const check: LocalCheckInput = {
        request:
            mode === "--full"
                ? { id: crypto.randomUUID(), commit, editsSha256: sha256 }
                : { id: crypto.randomUUID(), commit, patchSha256: sha256 },
        input: text,
    };
    const checked = journal();
    const result = await executeLocalCodeCheck(
        config,
        check,
        checked.record,
        controller.signal
    );
    assert.equal(
        result.exitCode,
        mode === "--full" ? 0 : 1,
        result.files.find((item) => item.name === "check-log.txt")?.text ??
            "No check log returned."
    );
    await checked.absent();

    const interrupted = journal();
    interrupted.record.starting = () => {
        setTimeout(() => controller.abort(), 1000);
        return Promise.resolve();
    };
    await assert.rejects(
        executeLocalCodeCheck(
            config,
            {
                request: { id: crypto.randomUUID(), commit, patchSha256: null },
                input: null,
            },
            interrupted.record,
            controller.signal
        )
    );
    await interrupted.absent();

    const owner = crypto.randomUUID();
    const made = await call(
        "POST",
        `/containers/create?name=mira-code-${owner}`,
        localCodeContainerSpec(validated, owner)
    );
    assert.equal(made.status, 201);
    const recovery = journal();
    await cleanupLocalCodeContainer(
        config,
        { id: owner, settled: false },
        recovery.record
    );
    await recovery.absent();
    process.stdout.write("LOCAL_CODE_IMAGE_SMOKE_OK\n");
}
if (import.meta.main) await main();
