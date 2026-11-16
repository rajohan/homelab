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

test("publication media selects JSON or passive SVG despite the original name", () => {
    const view = render(
        <TextFilePreview
            name="notes.md"
            mediaType="application/json"
            text={'{"id":9007199254740993,"negative":-0}'}
        />
    );
    try {
        expect(view.container.querySelector("pre")!.textContent).toBe(
            '{\n  "id": 9007199254740993,\n  "negative": -0\n}'
        );
        expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
        view.rerender(
            <TextFilePreview
                name="notes.md"
                mediaType="image/svg+xml"
                text={"<svg><script>bad()</script></svg>"}
            />
        );
        expect(view.container.querySelector("pre")!.textContent).toContain("<svg>");
        expect(view.container.querySelector("svg script")).toBeNull();
        expect(view.container.querySelector("img")).toBeNull();
    } finally {
        view.unmount();
    }
});
