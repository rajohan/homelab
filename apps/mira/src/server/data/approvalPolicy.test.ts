import { expect, test } from "bun:test";

import { miraChatSettingsSchema, miraDefaultChatSettings } from "@homelab/contracts/mira";
import * as v from "valibot";

import { daytonaCheckContent, daytonaSourceContent } from "../sandbox/profile";
import { miraJobApprovalScope, miraModeAllows } from "./approvalPolicy";

test("permission settings are explicit and cannot classify arbitrary commands as approved checks", () => {
    expect(
        v.parse(miraChatSettingsSchema, miraDefaultChatSettings).permissionMode
    ).toBeUndefined();
    expect(
        v.safeParse(miraChatSettingsSchema, {
            ...miraDefaultChatSettings,
            permissionMode: "trust-everything",
        }).success
    ).toBe(false);
    const id = crypto.randomUUID(),
        commit = "a".repeat(40);
    const content = daytonaCheckContent({ id, commit, patchSha256: null });
    expect(miraJobApprovalScope(id, content)).toBe("check");
    expect(
        miraJobApprovalScope(
            id,
            daytonaSourceContent({ id, commit, paths: ["package.json"] })
        )
    ).toBe("check");
    expect(
        miraJobApprovalScope(id, {
            ...content,
            command: content.command + "; echo bypass",
        })
    ).toBe("external");
    expect(miraJobApprovalScope(id, { ...content, outputs: ["credentials.txt"] })).toBe(
        "external"
    );
    expect(miraJobApprovalScope(crypto.randomUUID(), content)).toBe("external");
    expect(miraModeAllows("ask", "task")).toBe(false);
    expect(miraModeAllows("approve_for_me", "task")).toBe(true);
    expect(miraModeAllows("approve_for_me", "external")).toBe(false);
    expect(miraModeAllows("full_access", "external")).toBe(true);
});
