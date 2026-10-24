import { expect, test } from "bun:test";

import { taskMoveForDrop } from "./taskPresentation";

const task = {
    id: "01a16c76-133d-71c6-8c0b-990ab3b73a18",
    version: 7,
    title: "Review storage",
    description: "Keep the description when moving.",
    status: "todo",
    assignee: "operator",
    priority: "high",
    labels: ["storage"],
    dueAt: null,
    completionCriteria: "Report recorded",
    conversationId: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T01:00:00.000Z",
};

test("a board move retains the captured revision and content without sending read-only fields", () => {
    const input = taskMoveForDrop(task, "task-column:in_progress");
    expect(input).toMatchObject({
        id: task.id,
        version: 7,
        status: "in_progress",
        description: task.description,
        labels: ["storage"],
    });
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("updatedAt");
    expect(task.status).toBe("todo");
});

test("cancelled, unknown, malformed and same-column drops cannot create an update", () => {
    expect(taskMoveForDrop(task, undefined)).toBeUndefined();
    expect(taskMoveForDrop(task, "task-column:todo")).toBeUndefined();
    expect(taskMoveForDrop(task, "task-column:archived")).toBeUndefined();
    expect(
        taskMoveForDrop({ ...task, version: undefined }, "task-column:done")
    ).toBeUndefined();
    expect(taskMoveForDrop(undefined, "task-column:done")).toBeUndefined();
});
