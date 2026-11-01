import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BrowserTabBar } from "./BrowserTabBar";

test("browser tabs select and close the exact server ID, with read-only and last-tab guards", async () => {
    const first = crypto.randomUUID(),
        second = crypto.randomUUID();
    const tabs = {
        selectedId: first,
        items: [
            { id: first, url: "https://example.test/", title: "First" },
            { id: second, url: "https://example.test/", title: "Second" },
        ],
    };
    const commands: unknown[] = [];
    const send = (input: unknown) => commands.push(input);
    const view = render(<BrowserTabBar tabs={tabs} disabled={false} onCommand={send} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Second" }));
    await user.click(screen.getByRole("button", { name: "Close tab: First" }));
    expect(commands).toEqual([
        { action: "select", tabId: second },
        { action: "close", tabId: first },
    ]);
    view.rerender(<BrowserTabBar tabs={tabs} disabled onCommand={send} />);
    expect(
        screen
            .getAllByRole("button")
            .every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true);
    view.rerender(
        <BrowserTabBar
            tabs={{ ...tabs, items: tabs.items.slice(0, 1) }}
            disabled={false}
            onCommand={send}
        />
    );
    expect(screen.getByRole("button", { name: "Close tab: First" })).toBeDisabled();
});
