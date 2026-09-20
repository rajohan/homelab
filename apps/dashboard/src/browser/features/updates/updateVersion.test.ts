import { expect, test } from "bun:test";

import type { UpdateItem } from "@homelab/contracts/updates";

import { updateVersion } from "./updateVersion";

test("update versions keep Docker pins concise without inventing versions for opaque images", () => {
    const item: UpdateItem = {
        id: "test",
        name: "test",
        kind: "container",
        installed: "sha256:" + "a".repeat(64),
        available: null,
        status: "unknown",
        security: false,
        held: false,
    };
    expect(updateVersion(item, "installed")).toBe("sha256:aaaaaaaaaaaa");
    expect(updateVersion(item, "available")).toBe("Not checked");
    expect(
        updateVersion(
            { ...item, image: "example/web:1.2.3@sha256:" + "b".repeat(64) },
            "installed"
        )
    ).toBe("1.2.3 · sha256:bbbbbbbbbbbb");
    expect(
        updateVersion(
            { ...item, image: "example/web:latest", installedVersion: "1.2.3" },
            "installed"
        )
    ).toBe("latest (1.2.3)");
    expect(
        updateVersion({ ...item, kind: "os", installed: "1.2.3-1" }, "installed")
    ).toBe("1.2.3-1");
});
