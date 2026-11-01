import { expect, test } from "bun:test";

import {
    miraDefaultChatSettings,
    miraModelSchema,
    type MiraChatSettings,
} from "@homelab/contracts/mira";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import * as v from "valibot";

import { ModelSettings } from "./ModelSettings";
import { RecallSettings } from "./RecallSettings";

test("switching provider and model preserves explicit context opt-outs", async () => {
    let latest: MiraChatSettings = {
        ...miraDefaultChatSettings,
        useMemory: false,
        useHistory: false,
    };
    function Fixture() {
        const [draft, setDraft] = useState(latest);
        const change = (settings: MiraChatSettings) => {
            latest = settings;
            setDraft(settings);
        };
        return (
            <>
                <ModelSettings
                    draft={draft}
                    setDraft={change}
                    models={["fixture-native", "syn:large:text", "syn:small:text"].map(
                        (model) =>
                            v.parse(miraModelSchema, {
                                model,
                                isDefault: model === "fixture-native",
                            })
                    )}
                    defaultModel="fixture-native"
                    fresh
                />
                <RecallSettings settings={draft} onChange={change} />
            </>
        );
    }
    const view = render(<Fixture />);
    try {
        fireEvent.click(screen.getByLabelText("Model provider"));
        fireEvent.click(
            await screen.findByRole("option", { name: "Synthetic subscription" })
        );
        expect(latest.model).toBe("syn:large:text");
        fireEvent.click(screen.getByLabelText("Chat model"));
        fireEvent.click(await screen.findByRole("option", { name: "syn:small:text" }));
        expect(latest).toMatchObject({
            model: "syn:small:text",
            useMemory: false,
            useHistory: false,
        });
        expect(
            screen.getByRole("switch", { name: "Use saved memory" })
        ).not.toBeChecked();
        expect(
            screen.getByRole("switch", { name: "Use conversation history" })
        ).not.toBeChecked();
    } finally {
        view.unmount();
    }
});
