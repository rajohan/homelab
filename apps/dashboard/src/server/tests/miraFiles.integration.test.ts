import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import {
    deleteMiraFile,
    listMiraFiles,
    readMiraFile,
    saveMiraFile,
} from "@homelab/mira/data/files";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { syntheticPdf } from "../../../../mira/src/server/testing/document";
import { appRouter } from "../api/router";
import { miraFileRequest } from "../mira/files";
import { operationFixture } from "../testing/operations";

test("Mira uploads retain owned bytes across retries and reject tampering, symlinks and foreign access", async () => {
    const database = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-mira-file-test-"));
    const context = {
        client: database.client,
        owner: "operator",
        actor: "human:operator",
    };
    const input = {
        id: crypto.randomUUID(),
        name: "synthetic.csv",
        bytes: new TextEncoder().encode("one,two\n1,2"),
    };
    try {
        const saved = await saveMiraFile(context, directory, input);
        expect(await saveMiraFile(context, directory, input)).toEqual(saved);
        const read = await readMiraFile(context, directory, saved.id);
        expect(new TextDecoder().decode(read.bytes)).toBe("one,two\n1,2");
        await rejects(
            saveMiraFile(context, directory, {
                ...input,
                bytes: new TextEncoder().encode("different"),
            }),
            /already used/
        );
        await rejects(
            readMiraFile({ ...context, owner: "other" }, directory, saved.id),
            /not found/
        );
        await rejects(
            saveMiraFile(context, directory, {
                ...input,
                id: crypto.randomUUID(),
                name: "../escape",
            }),
            /without paths/
        );
        await writeFile(path.join(directory, saved.id), "tampered");
        await rejects(readMiraFile(context, directory, saved.id), /verified/);
        await unlink(path.join(directory, saved.id));
        await symlink(path.join(directory, "other-file"), path.join(directory, saved.id));
        await rejects(readMiraFile(context, directory, saved.id));
        await deleteMiraFile(context, directory, saved.id);
        await deleteMiraFile(context, directory, saved.id);
        const listed = await listMiraFiles(context);
        expect(listed.rows).toHaveLength(0);
        await rejects(readMiraFile(context, directory, saved.id), /not found/);
    } finally {
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("authenticated raw uploads and PDF previews keep binary bodies outside the JSON RPC limit", async () => {
    const database = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-mira-http-files-"));
    const context = {
        operations: { ...database, miraFilesDirectory: directory },
        principal: { kind: "human" as const, id: "operator", capabilities },
    };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => miraFileRequest(request, context),
    });
    const base = `http://127.0.0.1:${server.port}/api/mira/files`;
    const id = crypto.randomUUID();
    try {
        const response = await fetch(base, {
            method: "POST",
            body: Buffer.from(syntheticPdf()),
            headers: { "x-file-id": id, "x-file-name": "synthetic.pdf" },
        });
        expect(response.status).toBe(201);
        const download = await fetch(`${base}/${id}`);
        expect(download.headers.get("content-disposition")).toStartWith("attachment;");
        expect(download.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.from(await download.arrayBuffer())).toEqual(
            Buffer.from(syntheticPdf())
        );
        const preview = await fetch(`${base}/${id}?preview=text`);
        expect(preview.status).toBe(200);
        expect(await preview.text()).toContain("Synthetic Mira document");
        await rejects(
            miraFileRequest(new Request(base, { method: "POST" }), {
                ...context,
                principal: { kind: "automation", id: "machine", capabilities },
            }),
            /signed-in operator/
        );
    } finally {
        await server.stop(true);
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("attachment tools require the file to belong to the current conversation, even for the same owner", async () => {
    const database = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-mira-tool-files-"));
    const context = {
        client: database.client,
        owner: "operator",
        actor: "human:operator",
    };
    try {
        const file = await saveMiraFile(context, directory, {
            id: crypto.randomUUID(),
            name: "context.txt",
            bytes: new TextEncoder().encode("Selected synthetic context"),
        });
        const unselected = await saveMiraFile(context, directory, {
            id: crypto.randomUUID(),
            name: "private.txt",
            bytes: new TextEncoder().encode("Unselected private context"),
        });
        const api = appRouter.createCaller({
            operations: database,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        const chat = await api.conversations.create({ title: "Attachment scope" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Read the attached file.",
            attachmentIds: [file.id],
        });
        const run = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        const tool = createMiraTools(database.client, run!, directory).find(
            (entry) => entry.name === "mira_attachment_read"
        )!;
        const signal = AbortSignal.timeout(10_000);
        expect(
            await tool.execute({ id: file.id }, signal, {
                callId: "selected",
                threadId: "test",
                turnId: "test",
            })
        ).toContain("Selected synthetic context");
        const denied = await tool.execute({ id: unselected.id }, signal, {
            callId: "unselected",
            threadId: "test",
            turnId: "test",
        });
        expect(denied).toContain("not attached");
        expect(denied).not.toContain("Unselected private context");
    } finally {
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
});
