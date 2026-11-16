import { expect, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { FileLibrary } from "./FileLibrary";

test("files show their added date and open directly from the filename", () => {
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const identity = new IdentityClient();
    const file = {
        id: crypto.randomUUID(),
        name: "newest.txt",
        bytes: 42,
        mediaType: "text/plain",
        createdAt: "2026-11-16T12:00:00Z",
    };
    query.setQueryData(["operations", "mira", "files"], {
        pages: [{ rows: [file], nextCursor: null }],
        pageParams: [undefined],
    });
    query.setQueryData(["operations", "mira", "file-text", file.id], {
        text: "Saved file contents",
        truncated: false,
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <FileLibrary onClose={() => {}} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(screen.getByText("Newest files first")).toBeInTheDocument();
        expect(screen.getByText(/KiB · Added/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "newest.txt" }));
        expect(screen.getByRole("dialog", { name: "newest.txt" })).toBeInTheDocument();
        expect(screen.getByText("Saved file contents")).toBeInTheDocument();
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});
