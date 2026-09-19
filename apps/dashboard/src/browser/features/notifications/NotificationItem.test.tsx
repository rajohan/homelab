import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotificationItem } from "./NotificationItem";

test("notifications expose personal read controls, safe text and internal links", async () => {
    const action = mock();
    const notification = {
        id: crypto.randomUUID(),
        source: "jobs",
        title: "Job completed",
        message: "<script>not executable</script>",
        severity: "success" as const,
        destination: "jobs" as const,
        createdAt: "2026-09-19T10:00:00Z",
        readAt: null,
    };
    const view = render(
        <NotificationItem notification={notification} pending={false} onAction={action} />
    );
    expect(screen.getByText(notification.message)).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "Open jobs" })).toHaveAttribute(
        "href",
        "/jobs"
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Mark read: Job completed" }));
    expect(action).toHaveBeenCalledWith(notification.id, "read");
    view.rerender(
        <NotificationItem
            notification={{ ...notification, readAt: notification.createdAt }}
            pending={false}
            onAction={action}
        />
    );
    await user.click(screen.getByRole("button", { name: "Mark unread: Job completed" }));
    expect(action).toHaveBeenCalledWith(notification.id, "unread");
    await user.click(
        screen.getByRole("button", { name: "Delete notification: Job completed" })
    );
    expect(action).toHaveBeenCalledWith(notification.id, "dismiss");
    view.rerender(
        <NotificationItem
            notification={{
                ...notification,
                destination: null,
                source: "automation:123",
            }}
            pending
            onAction={action}
        />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
        screen.getByRole("button", { name: "Mark read: Job completed" })
    ).toBeDisabled();
});
