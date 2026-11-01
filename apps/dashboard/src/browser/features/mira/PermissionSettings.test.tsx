import { expect, test } from "bun:test";

import { miraDefaultChatSettings, type MiraChatSettings } from "@homelab/contracts/mira";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { PermissionSettings } from "./PermissionSettings";

test("Chat permissions default to asking and preserve provider, memory and execution choices", async () => {
    let latest: MiraChatSettings = {
        ...miraDefaultChatSettings,
        model: "syn:large:vision",
        useMemory: false,
        executionTarget: "main",
    };
    function Fixture() {
        const [settings, setSettings] = useState(latest);
        return (
            <PermissionSettings
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
        expect(screen.getByLabelText("Permissions")).toHaveTextContent(
            "Ask for approval"
        );
        fireEvent.click(screen.getByLabelText("Permissions"));
        fireEvent.click(await screen.findByRole("option", { name: "Approve for me" }));
        expect(latest).toMatchObject({
            permissionMode: "approve_for_me",
            model: "syn:large:vision",
            useMemory: false,
            executionTarget: "main",
        });
        expect(
            screen.getByText(/Emails and publications still need your approval/)
        ).toBeVisible();
        fireEvent.click(screen.getByLabelText("Permissions"));
        fireEvent.click(await screen.findByRole("option", { name: "Full access" }));
        expect(latest.permissionMode).toBe("full_access");
        expect(screen.getByText(/merging and deployment remain separate/)).toBeVisible();
        expect(screen.getByText(/browser and PC access still apply/)).toBeVisible();
        view.rerender(
            <PermissionSettings
                settings={latest}
                onChange={() => {
                    throw new Error("Disabled settings changed");
                }}
                disabled
            />
        );
        expect(screen.getByLabelText("Permissions")).toBeDisabled();
    } finally {
        view.unmount();
    }
});
