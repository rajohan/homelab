import { expect, mock, test } from "bun:test";

import { act, fireEvent, render, within } from "@testing-library/react";

import { intersectionFixture } from "../../../../../tests/intersectionFixture";
import { VirtualList } from "./VirtualList";

test("card lists window rows and automatically request their next cursor page", () => {
    const fixture = intersectionFixture();
    const frameWindow = fixture.container.ownerDocument.defaultView;
    if (!frameWindow) throw new Error("Expected an isolated browser window");
    Object.defineProperties(frameWindow.HTMLElement.prototype, {
        offsetHeight: { configurable: true, value: 520 },
        offsetWidth: { configurable: true, value: 960 },
    });
    const load = mock(() => {});
    const rows = Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        label: `Card ${index}`,
    }));
    const view = render(
        <VirtualList
            label="Accounts"
            scrollbarGap
            itemClassName="pb-0"
            rows={rows}
            getKey={(row) => row.id}
            renderItem={(row) => <span>{row.label}</span>}
            continuation={{ hasMore: true, loading: false, onLoadMore: load }}
        />,
        { container: fixture.container }
    );
    try {
        const screen = within(fixture.container);
        const viewport = screen.getByRole("region", { name: "Accounts" });
        expect(screen.getByText("Card 0")).toBeInTheDocument();
        expect(screen.getByRole("list")).toHaveClass("pe-2");
        expect(screen.getByText("Card 0").closest("li")).toHaveClass("pb-0");
        expect(screen.getByText("Card 0").closest("li")).not.toHaveClass("pb-3");
        expect(screen.queryByText("Card 99")).not.toBeInTheDocument();
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        viewport.scrollTop = 6000;
        fireEvent.scroll(viewport);
        expect(screen.queryByText("Card 0")).not.toBeInTheDocument();
        expect(screen.getAllByRole("listitem").length).toBeLessThan(rows.length);
        act(() => fixture.intersect());
        expect(load).toHaveBeenCalledTimes(1);
        view.rerender(
            <VirtualList
                label="Accounts"
                rows={rows.slice(0, 1)}
                getKey={(row) => row.id}
                renderItem={(row) => <span>{row.label}</span>}
                scrollbarGap
            />
        );
        expect(screen.getByRole("list")).not.toHaveClass("pe-2");
    } finally {
        view.unmount();
        fixture.close();
    }
});
