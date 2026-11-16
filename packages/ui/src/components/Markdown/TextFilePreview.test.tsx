import { expect, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import { TextFilePreview } from "./TextFilePreview";

test("Markdown files reuse formatted tables and headings while source remains available", () => {
    const view = render(
        <TextFilePreview
            name="report.md"
            mediaType="text/plain"
            text={
                "# Report\n\n| Status | Value |\n| --- | --- |\n| Checks | Passed |\n\n<script>window.bad=true</script>\n![remote](https://example.com/private.png)"
            }
        />
    );
    try {
        expect(screen.getByRole("heading", { name: "Report" })).toBeTruthy();
        expect(screen.getByRole("table")).toBeTruthy();
        expect(view.container.querySelector("script")).toBeNull();
        expect(view.container.querySelector("img")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Source" }));
        expect(view.container.querySelector("pre code")).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
    } finally {
        view.unmount();
    }
});

test("JSON and source previews tokenize supported syntax and bound large input", () => {
    const view = render(
        <TextFilePreview
            name="result.json"
            mediaType="text/plain"
            text={'{\n  "ok": true\n}'}
        />
    );
    try {
        expect(view.container.querySelectorAll("pre span").length).toBeGreaterThan(0);
        view.rerender(
            <TextFilePreview
                name="large.ts"
                mediaType="text/plain"
                text={"const value = 1;\n".repeat(4000)}
            />
        );
        expect(screen.getByText(/preview is shortened/)).toBeTruthy();
        expect(
            view.container.querySelector("pre")!.textContent.length
        ).toBeLessThanOrEqual(32_000);
    } finally {
        view.unmount();
    }
});
