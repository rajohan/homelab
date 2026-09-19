import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import { RunEvent } from "./RunEvent";

test("run events display generic progress and readable terminal outcomes as text", () => {
    const base = {
        actor: "system:worker",
        createdAt: "2026-09-19T12:00:00Z",
        message: null,
    };
    const view = render(
        <RunEvent
            event={{
                ...base,
                action: "jobs.progress",
                message: "Waiting for demo-web to become healthy.",
            }}
        />
    );
    expect(screen.getByText("Waiting for demo-web to become healthy.")).toBeVisible();
    view.rerender(<RunEvent event={{ ...base, action: "jobs.succeeded" }} />);
    expect(screen.getByText("Completed successfully")).toBeVisible();
    view.rerender(<RunEvent event={{ ...base, action: "custom.future-event" }} />);
    expect(screen.getByText("custom.future-event")).toBeVisible();
});
