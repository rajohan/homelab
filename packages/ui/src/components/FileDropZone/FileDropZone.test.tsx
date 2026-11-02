import { expect, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import { FileDropZone } from "./FileDropZone";

test("nested dragging stays visible, disabled drops cannot navigate and text dragging stays native", () => {
    const files = [new File(["fixture"], "test.txt")];
    const received: File[][] = [];
    const view = render(
        <FileDropZone onFiles={(value) => received.push(value)}>
            <textarea aria-label="Draft" />
            <span>Child</span>
        </FileDropZone>
    );
    try {
        const input = screen.getByRole("textbox");
        const dataTransfer = { types: ["Files"], files };
        fireEvent.dragEnter(input, { dataTransfer });
        fireEvent.dragEnter(screen.getByText("Child"), { dataTransfer });
        fireEvent.dragLeave(input, { dataTransfer });
        expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
        fireEvent.drop(input, { dataTransfer });
        expect(received).toEqual([files]);
        view.rerender(
            <FileDropZone disabled onFiles={(value) => received.push(value)}>
                <textarea aria-label="Draft" />
            </FileDropZone>
        );
        expect(fireEvent.drop(screen.getByRole("textbox"), { dataTransfer })).toBe(false);
        expect(received).toHaveLength(1);
        expect(
            fireEvent.drop(screen.getByRole("textbox"), {
                dataTransfer: { types: ["text/plain"], files: [] },
            })
        ).toBe(true);
    } finally {
        view.unmount();
    }
});
