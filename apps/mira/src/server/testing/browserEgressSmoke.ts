import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import { Effect } from "effect";
import * as v from "valibot";

import { browserDockerRequest } from "../browsing/docker";
import { browserEngineConfigurationSchema } from "../browsing/engine";
import { openBrowserWorker } from "../browsing/process";

async function qualify(file: string) {
    const config = v.parse(browserEngineConfigurationSchema, await Bun.file(file).json());
    assert.ok(config.egress);
    assert.equal(config.socketPath, await realpath("/var/run/docker.sock"));
    const call = browserDockerRequest(config.socketPath);
    const origin = "http://public.mira.test";
    const grant = { origins: [origin], initialUrl: origin + "/", mode: "control" };
    const owner = new AbortController();
    const publicWeb = await openBrowserWorker(
        config,
        { ...grant, origins: ["public-web"] },
        owner.signal
    );
    try {
        let frame = await publicWeb.observe(owner.signal);
        assert.equal(frame.title, "Mira isolated fixture");
        const link = frame.refs.find(
            (ref) => ref.role === "link" && ref.label === "Second website"
        );
        assert.ok(link);
        await publicWeb.act(
            { action: "click", observationId: frame.observationId, ref: link.ref },
            owner.signal
        );
        frame = await publicWeb.observe(owner.signal);
        assert.equal(frame.url, "http://second.mira.test/next");
        const field = frame.refs.find(
            (ref) => ref.actions.includes("type") && ref.label === "Fixture text"
        );
        assert.ok(field);
        await publicWeb.act(
            {
                action: "type",
                observationId: frame.observationId,
                ref: field.ref,
                text: "Public input",
                replace: true,
            },
            owner.signal
        );
        frame = await publicWeb.observe(owner.signal);
        assert.ok(frame.outline.includes("Public input"));
        assert.ok(!frame.refs.some((ref) => ref.label === "Secret"));
        assert.ok(!frame.outline.includes("do-not-expose-fixture"));
        assert.ok(
            !frame.refs.some(
                (ref) => ref.label === "Read only" && ref.actions.includes("type")
            )
        );
        for (const [text, replace] of [
            ["Updated", true],
            [" editor", false],
        ] as const) {
            const editor = frame.refs.find(
                (ref) => ref.label === "Editor" && ref.actions.includes("type")
            );
            assert.ok(editor);
            await publicWeb.act(
                {
                    action: "type",
                    observationId: frame.observationId,
                    ref: editor.ref,
                    text,
                    replace,
                },
                owner.signal
            );
            frame = await publicWeb.observe(owner.signal);
        }
        assert.ok(frame.outline.includes("Updated editor"));
        await publicWeb.tabs({ action: "open", url: origin }, owner.signal);
        const denied = await publicWeb
            .navigate("http://private.mira.test/", owner.signal)
            .catch(() => null);
        if (denied) {
            const blocked = await publicWeb.observe(owner.signal);
            assert.notEqual(blocked.title, "Mira isolated fixture");
        }
    } finally {
        await publicWeb.close();
    }
    const popupSession = await openBrowserWorker(
        config,
        { ...grant, origins: ["public-web"] },
        owner.signal
    );
    try {
        const observed = await popupSession.observe(owner.signal);
        const popup = observed.refs.find((ref) => ref.label === "Open popup");
        assert.ok(popup);
        await popupSession
            .act(
                {
                    action: "click",
                    ref: popup.ref,
                    observationId: observed.observationId,
                },
                owner.signal
            )
            .catch(() => null);
        await assert.rejects(popupSession.observe(owner.signal));
    } finally {
        await popupSession.close();
    }
    const browser = await openBrowserWorker(config, grant, owner.signal);
    try {
        let frame = await browser.observe(owner.signal);
        assert.equal(frame.title, "Mira isolated fixture");
        assert.ok(frame.content.content[0]?.data);
        const field = frame.refs.find(
            (ref) => ref.actions.includes("type") && ref.label.includes("Fixture text")
        );
        assert.ok(field);
        await browser.act(
            {
                action: "type",
                observationId: frame.observationId,
                ref: field.ref,
                text: "Isolated proxy qualification",
                replace: true,
            },
            owner.signal
        );
        frame = await browser.observe(owner.signal);
        assert.ok(frame.outline.includes("Isolated proxy qualification"));
        const button = frame.refs.find(
            (ref) => ref.actions.includes("click") && ref.label.includes("Count")
        );
        assert.ok(button);
        await browser.act(
            { action: "click", observationId: frame.observationId, ref: button.ref },
            owner.signal
        );
        frame = await browser.observe(owner.signal);
        assert.ok(frame.outline.includes("Clicked 1"));
        // Losing the exact proxy retires the live worker without waiting for another tool call.
        const stopped = await call(
            "POST",
            `/containers/${config.egress.proxyId}/stop?t=1`
        );
        assert.equal(stopped.status, 204);
        await Promise.race([
            new Promise<void>((resolve) =>
                browser.signal.aborted
                    ? resolve()
                    : browser.signal.addEventListener("abort", () => resolve(), {
                          once: true,
                      })
            ),
            Bun.sleep(10_000).then(() => {
                throw new Error("Proxy loss did not retire the browser.");
            }),
        ]);
    } finally {
        await browser.close();
    }
    return {
        actualChromium: true,
        screenshot: true,
        typedInput: true,
        clicked: true,
        publicDns: true,
        proxyLossRevoked: true,
        removed: true,
    };
}

if (import.meta.main) {
    const [file, ...extra] = process.argv.slice(2);
    if (!file || extra.length > 0)
        throw new Error("Provide the disposable test configuration.");
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: () => qualify(file),
            catch: (cause) =>
                new Error("Browser egress qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
