import { expect, mock, test } from "bun:test";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmDialog } from "./ConfirmDialog";

test("confirmation names its consequence, cancels safely and locks while submitting", async () => {
    const user = userEvent.setup();
    const onClose = mock(() => {});
    const pending = Promise.withResolvers<void>();
    const onConfirm = mock(() => pending.promise);
    const view = render(
        <ConfirmDialog
            title="Remove item?"
            description="This removes the selected item."
            confirmLabel="Remove item"
            onClose={onClose}
            onConfirm={onConfirm}
        />
    );
    try {
        const dialog = screen.getByRole("dialog", { name: "Remove item?" });
        expect(dialog).toHaveAccessibleDescription("This removes the selected item.");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole("button", { name: "Remove item" }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(
            within(dialog).getByRole("button", { name: "Please wait…" })
        ).toBeDisabled();
        expect(
            within(dialog).queryByRole("button", { name: "Close dialog" })
        ).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        await waitFor(() =>
            expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled()
        );
    } finally {
        pending.resolve();
        view.unmount();
    }
});

test("confirmation failures remain in the dialog and never retry automatically", async () => {
    const onConfirm = mock(() =>
        Promise.reject(new Error("This change could not be saved."))
    );
    const view = render(
        <ConfirmDialog
            title="Change setting?"
            description="A bounded test operation."
            onClose={() => {}}
            onConfirm={onConfirm}
        />
    );
    try {
        await userEvent.setup().click(screen.getByRole("button", { name: "Confirm" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "This change could not be saved."
        );
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
        expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
        view.unmount();
    }
});
