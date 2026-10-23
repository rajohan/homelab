import { expect, mock, spyOn, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
    AppErrorBoundary,
    Badge,
    Button,
    ErrorNotice,
    LoadingState,
    Modal,
} from "./index";

test("loading uses a stable accessible label and hides animated punctuation", () => {
    const { container } = render(<LoadingState label="Loading settings…" />);
    expect(screen.getByRole("status", { name: "Loading settings…" })).toHaveAttribute(
        "aria-busy",
        "true"
    );
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading settings...");
    expect(
        container.querySelectorAll(String.raw`.motion-reduce\:opacity-100`)
    ).toHaveLength(2);
});

test("busy buttons cannot submit twice and announce their loading label", async () => {
    const click = mock();
    render(
        <Button busy busyLabel="Saving settings…" onClick={click}>
            Save
        </Button>
    );
    const button = screen.getByRole("button", { name: "Saving settings…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.setup().click(button);
    expect(click).not.toHaveBeenCalled();
});

test("render errors are redacted and the view can retry", async () => {
    const loggedError = spyOn(console, "error").mockImplementation(() => {});
    const state = { failing: true };
    try {
        render(
            <AppErrorBoundary>
                <UnstableContent shouldFail={() => state.failing} />
            </AppErrorBoundary>
        );
        expect(screen.getByRole("alert")).toBeVisible();
        expect(
            screen.queryByText("Private test exception must not be rendered")
        ).not.toBeInTheDocument();
        state.failing = false;
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(screen.getByText("View recovered")).toBeVisible();
    } finally {
        loggedError.mockRestore();
    }
});

test("dialogs have a named close action and support Escape", async () => {
    const close = mock();
    render(
        <Modal title="Account action" onClose={close}>
            <p>Review this action.</p>
        </Modal>
    );
    expect(screen.getByRole("dialog", { name: "Account action" })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close dialog" }));
    expect(close).toHaveBeenCalledTimes(1);
    await userEvent.setup().keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(2);
});

function UnstableContent({ shouldFail }: { readonly shouldFail: () => boolean }) {
    if (shouldFail()) throw new Error("Private test exception must not be rendered");
    return <p>View recovered</p>;
}

test("status badges distinguish success, warnings and errors", () => {
    render(
        <div>
            <ErrorNotice error={new Error("Check the submitted fields.")} />
            <Badge tone="positive">Healthy</Badge>
            <Badge tone="warning">Needs attention</Badge>
            <Badge tone="danger">Failed</Badge>
        </div>
    );
    expect(screen.getByRole("alert")).toHaveClass("bg-red-500/10", "text-red-300");
    expect(screen.getByText("Needs attention")).toHaveClass(
        "bg-amber-500/10",
        "text-amber-300"
    );
    expect(screen.getByText("Healthy")).toHaveClass("bg-emerald-950", "text-emerald-300");
    expect(screen.getByText("Failed")).toHaveClass("bg-red-500/10", "text-red-300");
});

test("modal scroll content remains keyboard accessible without losing its close action", async () => {
    const close = mock();
    render(
        <Modal title="Long details" onClose={close}>
            {Array.from({ length: 30 }, (_, index) => (
                <p key={index}>Detail {index + 1}</p>
            ))}
            <Button>Last action</Button>
        </Modal>
    );
    const content = screen.getByRole("region", { name: "Long details content" });
    content.focus();
    expect(content).toHaveFocus();
    expect(content).toHaveTextContent("Detail 30");
    await userEvent.setup().tab();
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    await userEvent.setup().keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
});
