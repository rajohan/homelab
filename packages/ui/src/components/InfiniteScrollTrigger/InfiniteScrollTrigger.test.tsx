import { expect, mock, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import { InfiniteScrollTrigger } from "./InfiniteScrollTrigger";

test("continuation copy belongs to its consumer, not to the shared component", () => {
    const load = mock(() => {});
    const props = {
        rootRef: { current: null },
        hasMore: true,
        loading: false,
        onLoadMore: load,
        loadingLabel: "Loading hosts…",
        loadMoreLabel: "More hosts",
        retryLabel: "Retry hosts",
    };
    const view = render(<InfiniteScrollTrigger {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More hosts" }));
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<InfiniteScrollTrigger {...props} loading />);
    expect(screen.getByRole("status", { name: "Loading hosts…" })).toBeVisible();
    view.rerender(<InfiniteScrollTrigger {...props} error={new Error("Unavailable")} />);
    expect(screen.getByRole("button", { name: "Retry hosts" })).toBeVisible();
    view.rerender(<InfiniteScrollTrigger {...props} hasMore={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
