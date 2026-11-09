import { expect, test } from "bun:test";

import { type MiraChatSettings, miraDefaultChatSettings } from "@homelab/contracts/mira";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { AssistanceSettings } from "./AssistanceSettings";

test("live assistance is opt-in and preserves model and permission choices", async () => {
    let latest: MiraChatSettings = {
        ...miraDefaultChatSettings,
        model: "syn:large:vision",
        permissionMode: "ask",
        useHistory: false,
    };
    function Fixture() {
        const [settings, setSettings] = useState(latest);
        return (
            <AssistanceSettings
                settings={settings}
                onChange={(next) => {
                    latest = next;
                    setSettings(next);
                }}
            />
        );
    }
    const view = render(<Fixture />);
    try {
        expect(screen.getByLabelText("Live computer assistance")).toHaveTextContent(
            "Off"
        );
        fireEvent.click(screen.getByLabelText("Live computer assistance"));
        fireEvent.click(
            await screen.findByRole("option", { name: "Continue for up to 1 hour" })
        );
        expect(latest).toMatchObject({
            liveAssistanceMinutes: 60,
            model: "syn:large:vision",
            permissionMode: "ask",
            useHistory: false,
        });
        view.rerender(
            <AssistanceSettings
                settings={latest}
                onChange={() => {
                    throw new Error("Disabled choices changed");
                }}
                disabled
            />
        );
        expect(screen.getByLabelText("Live computer assistance")).toBeDisabled();
    } finally {
        view.unmount();
    }
});
