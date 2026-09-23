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
    expect(screen.getByRole("article")).toHaveClass(
        "bg-primary-900",
        "border-primary-700"
    );
    expect(screen.getByText("Unread")).toBeVisible();
    expect(screen.getByText("Unread")).toHaveClass(
        "rounded-md",
        "bg-accent-500/10",
        "text-accent-300"
    );
    expect(screen.getByText("Unread").nextElementSibling).toBe(
        screen.getByText("success")
    );
    expect(screen.getByText("Unread").parentElement).toBe(
        screen.getByText("success").parentElement
    );
    expect(
        screen.getByRole("heading", { name: notification.title })
    ).not.toHaveTextContent("Unread");
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
    expect(screen.getByRole("article")).toHaveClass(
        "bg-primary-900",
        "border-primary-700"
    );
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(action).toHaveBeenCalledWith(notification.id, "unread");
    await user.click(
        screen.getByRole("button", { name: "Delete notification: Job completed" })
    );
    expect(action).toHaveBeenCalledWith(notification.id, "dismiss");
    view.rerender(
        <NotificationItem
            notification={{
                ...notification,
                severity: "error",
                destination: null,
                source: "automation:123",
            }}
            pending
            onAction={action}
        />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Unread").nextElementSibling).toBe(screen.getByText("error"));
    expect(
        screen.getByRole("button", { name: "Mark read: Job completed" })
    ).toBeDisabled();
});
