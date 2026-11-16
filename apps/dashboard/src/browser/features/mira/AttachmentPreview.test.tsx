import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

import { AttachmentPreview } from "./AttachmentPreview";

test("publication SVG snapshots open the stored text preview instead of a broken image", () => {
    const id = crypto.randomUUID();
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>Preview</text></svg>';
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["operations", "mira", "file-text", id], {
        text: source,
        truncated: false,
    });
    const view = render(
        <QueryClientProvider client={client}>
            <AttachmentPreview
                file={{
                    id,
                    name: "notes.md",
                    mediaType: "image/svg+xml",
                    bytes: source.length,
                }}
                onClose={() => {}}
            />
        </QueryClientProvider>
    );
    try {
        const dialog = screen.getByRole("dialog");
        expect(dialog.querySelector("pre")!.textContent).toBe(source);
        expect(dialog.querySelector("img")).toBeNull();
    } finally {
        view.unmount();
        client.clear();
    }
});
