import { expect, test } from "bun:test";

import { miraDefaultChatSettings } from "@homelab/contracts/mira";

import { liveAssistanceMinutes } from "./liveAssistance";

test("only explicitly configured direct Chat receives the longer assistance budget", () => {
    expect(liveAssistanceMinutes(miraDefaultChatSettings, { manual: true })).toBe(0);
    const settings = { ...miraDefaultChatSettings, liveAssistanceMinutes: 60 as const };
    expect(liveAssistanceMinutes(settings, { manual: true })).toBe(60);
    expect(liveAssistanceMinutes(settings, { manual: false })).toBe(0);
    expect(
        liveAssistanceMinutes(settings, { manual: true, automationId: "automation" })
    ).toBe(0);
    expect(liveAssistanceMinutes(settings, { manual: true, taskId: "task" })).toBe(0);
});
