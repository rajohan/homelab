import { expect, mock, test } from "bun:test";

import { act, fireEvent, render, within } from "@testing-library/react";

import { intersectionFixture } from "../../../../../tests/intersectionFixture";
import { InfiniteScrollTrigger } from "./InfiniteScrollTrigger";

test("continuation loads automatically once per page and exposes only failure retry", () => {
    const fixture = intersectionFixture();
    const load = mock(() => {});
    const props = {
        rootRef: { current: null },
        itemCount: 20,
        hasMore: true,
        loading: false,
        onLoadMore: load,
        loadingLabel: "Loading hosts…",
        retryLabel: "Retry hosts",
    };
    const view = render(<InfiniteScrollTrigger {...props} />, {
        container: fixture.container,
    });
    const screen = within(fixture.container);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    act(() => {
        fixture.intersect();
        fixture.intersect();
    });
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<InfiniteScrollTrigger {...props} loading />);
    expect(screen.getByRole("status", { name: "Loading hosts…" })).toBeVisible();
    view.rerender(<InfiniteScrollTrigger {...props} error={new Error("Unavailable")} />);
    expect(screen.getByRole("button", { name: "Retry hosts" })).toBeVisible();
    act(() => fixture.intersect());
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry hosts" }));
    expect(load).toHaveBeenCalledTimes(2);
    view.rerender(<InfiniteScrollTrigger {...props} itemCount={40} />);
    act(() => fixture.intersect());
    expect(load).toHaveBeenCalledTimes(3);
    view.rerender(<InfiniteScrollTrigger {...props} hasMore={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.unmount();
    act(() => fixture.intersect());
    expect(load).toHaveBeenCalledTimes(3);
    fixture.close();
});
