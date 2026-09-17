import { expect, test } from "bun:test";

import { capabilities, type Capability } from "@homelab/contracts/operations";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CapabilityPicker } from "./CapabilityPicker";

test("permission picker exposes granular grants without implicitly granting dependencies", async () => {
    let selected: Capability[] = [];
    const view = render(
        <CapabilityPicker
            value={selected}
            onChange={(value) => {
                selected = value;
            }}
        />
    );
    try {
        const user = userEvent.setup();
        expect(screen.getAllByRole("switch")).toHaveLength(capabilities.length);
        await user.click(screen.getByRole("switch", { name: "Run jobs" }));
        expect(selected).toEqual(["jobs:run"]);
        await user.click(screen.getByRole("button", { name: "Select all" }));
        expect(selected).toEqual(capabilities);
        await user.click(screen.getByRole("button", { name: "Clear selection" }));
        expect(selected).toEqual([]);
    } finally {
        view.unmount();
    }
});
