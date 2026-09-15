import { expect, spyOn, test } from "bun:test";

import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { CopyTextButton } from "./CopyTextButton";

test("clipboard writes happen only on click and reset feedback for different text", async () => {
    const clipboard = { writeText: async (_text: string) => {} };
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboard,
    });
    const write = spyOn(clipboard, "writeText");
    const view = render(
        <CopyTextButton label="Copy fixture" text="synthetic text" iconOnly />
    );
    try {
        expect(write).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Copy fixture" }));
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Copy fixture (copied)" })
            ).toBeVisible()
        );
        expect(write).toHaveBeenCalledWith("synthetic text");
        expect(screen.getByRole("status")).toHaveTextContent("copied");
        view.rerender(<CopyTextButton label="Copy fixture" text="another fixture" />);
        expect(screen.getByRole("button", { name: "Copy fixture" })).toHaveTextContent(
            "Copy"
        );
        write.mockRejectedValue(new Error("Synthetic permission denial"));
        fireEvent.click(screen.getByRole("button", { name: "Copy fixture" }));
        await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(
                "Select the text and copy it manually."
            )
        );
    } finally {
        view.unmount();
        write.mockRestore();
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
    }
});
