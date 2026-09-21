import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import { RestartStatus } from "./RestartStatus";

test("restart state distinguishes a current warning, absence of a flag and unavailable observations", () => {
    const observation = {
        required: true,
        observedAt: "2026-09-21T12:00:00Z",
        stale: false,
    };
    const view = render(<RestartStatus observation={observation} unavailable={false} />);
    try {
        expect(screen.getByText("Restart required")).toBeTruthy();
        view.rerender(
            <RestartStatus
                observation={{ ...observation, required: false }}
                unavailable={false}
            />
        );
        expect(screen.getByText("No restart reported")).toBeTruthy();
        for (const state of [
            null,
            undefined,
            { ...observation, stale: true },
            { ...observation, required: null },
        ]) {
            view.rerender(<RestartStatus observation={state} unavailable={false} />);
            expect(screen.getByText("Unknown")).toBeTruthy();
            expect(screen.queryByText("No restart reported")).toBeNull();
        }
        view.rerender(<RestartStatus observation={observation} unavailable />);
        expect(screen.getByText("Unknown")).toBeTruthy();
    } finally {
        view.unmount();
    }
});
