import { expect, mock, test } from "bun:test";

import type { JobSummary, ScheduleSummary } from "@homelab/contracts/operations";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { DisableScheduleDialog } from "./DisableScheduleDialog";
import { JobActivity } from "./JobActivity";
import { JobActivityContext } from "./JobActivityContext";
import { JobActivityItem } from "./JobActivityItem";
import { JobHistory } from "./JobHistory";
import { JobRunTable } from "./JobRunTable";
import { JobStatus } from "./JobStatus";
import { RunDetailDialog } from "./RunDetailDialog";
import { ScheduleDialog } from "./ScheduleDialog";
import { SchedulesPanel } from "./SchedulesPanel";
import { useJobOperation } from "./useJobOperation";
import { WorkerPanel } from "./WorkerPanel";

const schedule: ScheduleSummary = {
    id: "019959a7-4600-7000-8000-000000000001",
    action: "system.retention",
    label: "Clean up history",
    description: "Remove expired completed runs.",
    resourceClass: "light",
    attemptLimit: 2,
    timeoutMs: 10_000,
    manualRunAvailable: true,
    activeRun: null,
    enabled: true,
    disableReason: null,
    disabledUntil: null,
    schedule: { kind: "interval", intervalSeconds: 3600 },
    nextRunAt: "2026-09-20T10:00:00Z",
    version: 1,
};

const activityRun: JobSummary = {
    id: "019959a7-4600-7000-8000-000000000009",
    action: "applications.restart",
    label: "Restart web",
    resourceClass: "light",
    state: "running",
    attempt: 1,
    attemptLimit: 1,
    requestedBy: "human:test",
    createdAt: "2026-09-17T10:00:00Z",
    startedAt: "2026-09-17T10:00:01Z",
    finishedAt: null,
    message: "Waiting for web to become healthy.",
    cancelRequested: false,
};

function fixture(children: ReactNode, configure?: (query: QueryClient) => void) {
    const identity = new IdentityClient();
    const query = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    configure?.(query);
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <div
                    ref={(element) => {
                        for (const viewport of element?.querySelectorAll(
                            "section[tabindex]"
                        ) ?? []) {
                            Object.defineProperties(viewport, {
                                offsetHeight: { value: 520, configurable: true },
                                offsetWidth: { value: 960, configurable: true },
                            });
                        }
                    }}
                >
                    {children}
                </div>
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        view.unmount();
        identity.cancelActions();
        query.clear();
    };
}

function measurePortals() {
    // Portalled panels and dialogs are outside the fixture's measured container.
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    if (!height || !width) throw new Error("Expected browser dimension accessors");
    Object.defineProperties(HTMLElement.prototype, {
        offsetHeight: { configurable: true, value: 288 },
        offsetWidth: { configurable: true, value: 480 },
    });
    return () =>
        Object.defineProperties(HTMLElement.prototype, {
            offsetHeight: height,
            offsetWidth: width,
        });
}

test("job activity opens details on demand, survives closing them and dismisses completed results", async () => {
    const restoreMeasurements = measurePortals();
    let queries: QueryClient | undefined;
    const cleanup = fixture(<JobActivity />, (query) => {
        queries = query;
        query.setQueryData(["operations", "jobs", "activity"], { runs: [activityRun] });
        query.setQueryData(["operations", "jobs", "detail", activityRun.id], {
            pages: [
                {
                    run: {
                        ...activityRun,
                        timeoutMs: 30_000,
                        retrySafe: false,
                        resourceKeys: [],
                    },
                    events: [],
                    nextCursor: null,
                },
            ],
            pageParams: [undefined],
        });
    });
    try {
        const user = userEvent.setup();
        const trigger = screen.getByRole("button", {
            name: "Worker activity, 1 running, 0 queued",
        });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(trigger.querySelector("svg")?.getAttribute("class")).toContain(
            "motion-safe:animate-"
        );
        expect(
            screen.queryByRole("region", { name: "Your job activity" })
        ).not.toBeInTheDocument();
        await user.click(trigger);
        const activity = screen.getByRole("region", { name: "Your job activity" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(
            within(activity).getByText("Waiting for web to become healthy.")
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Dismiss Restart web" })
        ).not.toBeInTheDocument();
        for (let index = 0; index < 2; index += 1) {
            await user.click(screen.getByRole("button", { name: "View Restart web" }));
            expect(screen.getByRole("dialog", { name: "Restart web" })).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Close dialog" }));
            expect(trigger).toHaveAttribute("aria-expanded", "false");
            await user.click(trigger);
            expect(
                screen.getByRole("region", { name: "Your job activity" })
            ).toBeVisible();
        }
        await user.click(trigger);
        await act(() => {
            queries?.setQueryData(["operations", "jobs", "activity"], {
                runs: [{ ...activityRun, state: "succeeded", message: null }],
            });
            return Promise.resolve();
        });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(
            await screen.findByRole("button", {
                name: "Worker activity, 0 running, 0 queued",
            })
        ).toBe(trigger);
        expect(trigger.querySelector("svg")?.getAttribute("class") ?? "").not.toContain(
            "animate-"
        );
        await user.click(trigger);
        await user.click(
            await screen.findByRole("button", { name: "Dismiss Restart web" })
        );
        expect(
            screen.queryByRole("region", { name: "Your job activity" })
        ).not.toBeInTheDocument();
        expect(screen.getByText("No active or recently completed jobs.")).toBeVisible();
    } finally {
        cleanup();
        restoreMeasurements();
    }
});

test.each([true, false])(
    "manual job activity opens only after successful admission (%s)",
    async (accepted) => {
        const identity = new IdentityClient();
        const queries = new QueryClient({
            defaultOptions: { mutations: { retry: false } },
        });
        const reveal = mock(() => {});
        const view = renderHook(
            () =>
                useJobOperation(() =>
                    accepted
                        ? Promise.resolve({ id: activityRun.id })
                        : Promise.reject(new Error("Rejected"))
                ),
            {
                wrapper: ({ children }) => (
                    <QueryClientProvider client={queries}>
                        <IdentityClientContext value={identity}>
                            <JobActivityContext value={reveal}>
                                {children}
                            </JobActivityContext>
                        </IdentityClientContext>
                    </QueryClientProvider>
                ),
            }
        );
        try {
            let result: string | undefined;
            await act(async () => {
                result = await view.result.current.mutateAsync(undefined).then(
                    () => "accepted",
                    () => "rejected"
                );
            });
            expect(result).toBe(accepted ? "accepted" : "rejected");
            expect(reveal).toHaveBeenCalledTimes(accepted ? 1 : 0);
        } finally {
            view.unmount();
            queries.clear();
            identity.cancelActions();
        }
    }
);

test.each([
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
] as const)(
    "job activity presents %s without embedding controls inside its run button",
    async (state) => {
        const select = mock(() => {}),
            dismiss = mock(() => {});
        const cleanup = fixture(
            <JobActivityItem
                run={{ ...activityRun, state, message: null }}
                unavailable={false}
                onSelect={select}
                onDismiss={dismiss}
            />
        );
        try {
            const user = userEvent.setup();
            const button = screen.getByRole("button", { name: "View Restart web" });
            expect(button.querySelector("button")).toBeNull();
            await user.click(button);
            expect(select).toHaveBeenCalledTimes(1);
            await user.keyboard("{Enter}");
            expect(select).toHaveBeenCalledTimes(2);
            if (state !== "queued" && state !== "running") {
                await user.click(
                    screen.getByRole("button", { name: "Dismiss Restart web" })
                );
                expect(dismiss).toHaveBeenCalledTimes(1);
                expect(select).toHaveBeenCalledTimes(2);
            }
        } finally {
            cleanup();
        }
    }
);

test("unavailable activity does not present cached work as a live status", () => {
    const cleanup = fixture(
        <JobActivityItem
            run={{ ...activityRun, cancelRequested: true }}
            unavailable
            onSelect={() => {}}
            onDismiss={() => {}}
        />
    );
    try {
        expect(screen.getByText("Status unavailable")).toBeVisible();
        expect(screen.getByText("Cancellation requested.")).toBeVisible();
        expect(screen.queryByText("running")).not.toBeInTheDocument();
        expect(document.querySelector(String.raw`.motion-safe\:animate-spin`)).toBeNull();
    } finally {
        cleanup();
    }
});

test("schedule dialog switches between daily, interval and cron without a time-zone field", async () => {
    const close = mock(() => {});
    const cleanup = fixture(<ScheduleDialog schedule={schedule} onClose={close} />);
    try {
        const user = userEvent.setup();
        expect(screen.getByLabelText("Interval in minutes")).toHaveValue("60");
        await user.click(screen.getByRole("button", { name: "Schedule type" }));
        await user.click(screen.getByRole("option", { name: "Daily" }));
        expect(screen.getByRole("button", { name: "Time, hour" })).toHaveTextContent(
            "04"
        );
        expect(document.querySelector('input[type="time"]')).toBeNull();
        await user.click(screen.getByRole("button", { name: "Schedule type" }));
        await user.click(screen.getByRole("option", { name: "Cron" }));
        expect(screen.getByLabelText("Cron expression")).toHaveValue("0 4 * * *");
        expect(screen.queryByLabelText(/time zone/i)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(close).toHaveBeenCalledTimes(1);
    } finally {
        cleanup();
    }
});

test("disable dialog captures a reason and offers an explicit future resume time", async () => {
    const cleanup = fixture(
        <DisableScheduleDialog schedule={schedule} onClose={() => {}} />
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));
        expect(screen.getByLabelText("Reason")).toHaveAttribute("aria-invalid", "true");
        await user.type(screen.getByLabelText("Reason"), "Planned maintenance");
        await user.click(screen.getByRole("switch", { name: "Resume automatically" }));
        expect(screen.getByRole("group", { name: "Resume at" })).toBeVisible();
        expect(screen.getByRole("button", { name: /Choose Date/ })).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Time (24-hour), hour" })
        ).toBeVisible();
        expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    } finally {
        cleanup();
    }
});

test.each([false, true])(
    "worker view has one shared footer control and zero counts when paused is %s",
    async (paused) => {
        const cleanup = fixture(<WorkerPanel />, (query) =>
            query.setQueryData(["operations", "worker"], {
                workers: [],
                counts: [],
                oldestQueuedAt: null,
                control: {
                    paused,
                    version: 2,
                    updatedAt: null,
                    updatedBy: "human:test",
                },
            })
        );
        try {
            const user = userEvent.setup();
            expect(screen.getAllByText("0")).toHaveLength(6);
            expect(screen.getByText("timed out")).toBeVisible();
            expect(screen.getByRole("heading", { name: "Worker" })).toBeVisible();
            expect(screen.queryByText(/execution slots/)).not.toBeInTheDocument();
            expect(screen.getByText("queued")).toBeVisible();
            expect(screen.getByText("running")).toBeVisible();
            const actionLabel = paused ? "Resume worker" : "Pause worker";
            const control = screen.getByRole("button", { name: actionLabel });
            expect(screen.getAllByRole("button", { name: actionLabel })).toHaveLength(1);
            expect(control).toHaveClass(
                "w-full",
                "@min-[48rem]:col-start-2",
                "@min-[48rem]:row-start-1",
                "@min-[48rem]:w-auto"
            );
            expect(
                screen.getByText(/The setting is shared by all workers/)
            ).toBeVisible();
            expect(control.previousElementSibling).toContainElement(
                screen.getByRole("region", { name: "Workers" })
            );
            await user.click(control);
            expect(screen.getByRole("dialog", { name: `${actionLabel}?` })).toBeVisible();
            expect(
                screen.getByText(
                    paused
                        ? /Missed schedule occurrences/
                        : /Pause new work across all workers/
                )
            ).toBeVisible();
        } finally {
            cleanup();
        }
    }
);

test("schedule history opens from its row while menu actions stay independent", async () => {
    const cleanup = fixture(<SchedulesPanel />, (query) => {
        query.setQueryData(["operations", "schedules"], [schedule]);
        query.setQueryDefaults(["operations", "jobs"], { enabled: false });
    });
    try {
        const user = userEvent.setup();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Actions for Clean up history" })
        );
        expect(screen.getByRole("menuitem", { name: "Run now" })).toBeVisible();
        expect(screen.getByRole("menuitem", { name: "Edit schedule" })).toBeVisible();
        expect(screen.getByRole("menuitem", { name: "Disable schedule" })).toBeVisible();
        expect(
            screen.queryByRole("menuitem", { name: "History" })
        ).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Edit schedule" }));
        expect(screen.getByRole("dialog", { name: "Edit schedule" })).toBeVisible();
        expect(
            screen.queryByRole("dialog", { name: schedule.label })
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        const row = screen.getByRole("button", {
            name: "Open history for Clean up history",
        });
        await user.click(row);
        const dialog = screen.getByRole("dialog", { name: schedule.label });
        expect(dialog).toBeVisible();
        expect(dialog).toHaveAccessibleDescription(
            "Run history, execution status and recorded events."
        );
        expect(screen.getByRole("heading", { name: schedule.label })).toBeVisible();
        expect(screen.queryByText(/Next run:/)).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: "Run history" })
        ).not.toBeInTheDocument();
        expect(dialog.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        row.focus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("dialog", { name: schedule.label })).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        row.focus();
        await user.keyboard(" ");
        expect(screen.getByRole("dialog", { name: schedule.label })).toBeVisible();
    } finally {
        cleanup();
    }
});

test("stopping an active run requires confirmation and cancelling leaves the job untouched", async () => {
    const select = mock(() => {});
    const cleanup = fixture(
        <JobRunTable
            rows={[
                {
                    id: "019959a7-4600-7000-8000-000000000003",
                    action: "system.retention",
                    label: "Active cleanup",
                    resourceClass: "light",
                    state: "running",
                    attempt: 1,
                    attemptLimit: 2,
                    requestedBy: "human:test",
                    createdAt: "2026-09-17T10:00:00Z",
                    startedAt: "2026-09-17T10:00:01Z",
                    finishedAt: null,
                    message: null,
                    cancelRequested: false,
                },
            ]}
            onSelect={select}
        />
    );
    try {
        const user = userEvent.setup();
        const stop = screen.getByRole("button", { name: "Stop Active cleanup" });
        expect(screen.getByRole("columnheader", { name: "Stop" })).toHaveClass("w-16");
        await user.click(stop);
        expect(screen.getByRole("dialog", { name: "Stop this job?" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Stop job" })).toBeEnabled();
        expect(select).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(stop).toBeEnabled();
        expect(screen.getByText("running")).toBeVisible();
    } finally {
        cleanup();
    }
});

test("job badges remain content-width when mobile table cells become grids", () => {
    const view = render(<JobStatus state="succeeded" />);
    try {
        expect(screen.getByText("succeeded").parentElement).toHaveClass(
            "w-fit",
            "self-start"
        );
    } finally {
        view.unmount();
    }
});

test("completed runs open from the row without an actions column", async () => {
    const select = mock(() => {});
    const run: JobSummary = {
        id: "019959a7-4600-7000-8000-000000000002",
        action: "system.retention",
        label: "Clean up history",
        resourceClass: "light",
        state: "succeeded",
        attempt: 1,
        attemptLimit: 2,
        requestedBy: "human:test",
        createdAt: "2026-09-17T10:00:00Z",
        startedAt: null,
        finishedAt: null,
        message: null,
        cancelRequested: false,
    };
    const cleanup = fixture(<JobRunTable rows={[run]} onSelect={select} />);
    try {
        const user = userEvent.setup();
        expect(
            screen.queryByRole("columnheader", { name: "Actions" })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("columnheader", { name: "Stop" })
        ).not.toBeInTheDocument();
        expect(screen.getByText("User: test")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: /Open details for Clean up history/ })
        );
        expect(select).toHaveBeenCalledWith(run.id);
    } finally {
        cleanup();
    }
});

test("the empty active queue uses the same bordered surface as other empty states", () => {
    const cleanup = fixture(
        <JobHistory view="active" title="Queued and running" />,
        (query) => {
            query.setQueryData(["operations", "jobs", "history", undefined, "active"], {
                pages: [{ runs: [], nextCursor: null }],
                pageParams: [undefined],
            });
        }
    );
    try {
        expect(screen.getByText("No queued or running jobs.")).toHaveClass(
            "rounded-lg",
            "border",
            "bg-primary-950/40"
        );
    } finally {
        cleanup();
    }
});

test("schedule inventory shows disabled intent, resume time and independent row actions", () => {
    const cleanup = fixture(<SchedulesPanel />, (query) => {
        query.setQueryData(
            ["operations", "schedules"],
            [
                schedule,
                {
                    ...schedule,
                    id: "019959a7-4600-7000-8000-000000000004",
                    label: "Paused cleanup",
                    enabled: false,
                    disableReason: "Waiting for maintenance",
                },
                {
                    ...schedule,
                    id: "019959a7-4600-7000-8000-000000000005",
                    label: "Resuming cleanup",
                    enabled: false,
                    disableReason: "Temporary maintenance",
                    disabledUntil: "2026-09-21T10:00:00Z",
                },
            ]
        );
    });
    try {
        expect(screen.getByRole("heading", { name: "Schedules" })).toBeVisible();
        expect(screen.getByText("Enabled")).toBeVisible();
        expect(screen.getAllByText("Disabled")).toHaveLength(2);
        expect(screen.getByText("Disabled indefinitely")).toBeVisible();
        expect(screen.getByText(/^Resumes /)).toBeVisible();
        expect(screen.getByText("Waiting for maintenance")).toBeVisible();
        expect(screen.getAllByText("Every 60 minutes")).toHaveLength(3);
        expect(
            screen.getByRole("button", { name: "Actions for Paused cleanup" })
        ).toBeVisible();
    } finally {
        cleanup();
    }
});

test.each([false, true])(
    "run details render policy and paginated events (completed: %s)",
    async (completed) => {
        const id = "019959a7-4600-7000-8000-000000000006";
        const close = mock(() => {});
        const restoreMeasurements = measurePortals();
        const cleanup = fixture(<RunDetailDialog id={id} onClose={close} />, (query) => {
            query.setQueryData(["operations", "jobs", "detail", id], {
                pages: [
                    {
                        run: {
                            id,
                            action: "system.retention",
                            label: "Inspected cleanup",
                            resourceClass: "light",
                            state: completed ? "failed" : "queued",
                            attempt: 1,
                            attemptLimit: 2,
                            requestedBy: "human:test",
                            createdAt: "2026-09-17T10:00:00Z",
                            startedAt: completed ? "2026-09-17T10:00:01Z" : null,
                            finishedAt: completed ? "2026-09-17T10:00:02Z" : null,
                            message: completed ? "Execution failed." : null,
                            cancelRequested: false,
                            resourceKeys: ["maintenance:operations"],
                            timeoutMs: 30_000,
                            retrySafe: completed,
                        },
                        events: [
                            ...(completed
                                ? [
                                      {
                                          id: "019959a7-4600-7000-8000-000000000008",
                                          actor: "system:worker",
                                          action: "jobs.failed",
                                          message: "Execution failed.",
                                          createdAt: "2026-09-17T10:00:02Z",
                                      },
                                  ]
                                : []),
                            {
                                id: "019959a7-4600-7000-8000-000000000007",
                                actor: "human:test",
                                action: "jobs.enqueue",
                                message: null,
                                createdAt: "2026-09-17T10:00:00Z",
                            },
                        ],
                        nextCursor: completed
                            ? "019959a7-4600-7000-8000-000000000007"
                            : null,
                    },
                ],
                pageParams: [undefined],
            });
        });
        try {
            expect(
                screen.getByRole("dialog", { name: "Inspected cleanup" })
            ).toBeVisible();
            expect(screen.getByText("30 seconds")).toBeVisible();
            expect(screen.getByText(completed ? "Yes" : "No")).toBeVisible();
            expect(screen.getByRole("region", { name: "Run events" })).toHaveClass(
                "bg-primary-950/40"
            );
            expect(
                within(screen.getByRole("region", { name: "Run events" })).getByText(
                    "Queued"
                )
            ).toBeVisible();
            if (completed) {
                expect(
                    within(screen.getByRole("region", { name: "Run events" })).getByText(
                        "Execution failed."
                    )
                ).toBeVisible();
                expect(screen.getAllByText("Execution failed.")).toHaveLength(1);
            } else {
                expect(screen.getByText("Not started")).toBeVisible();
                expect(screen.getByText("Not finished")).toBeVisible();
            }
            expect(
                screen.queryByRole("button", { name: /Load older/ })
            ).not.toBeInTheDocument();
            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Close dialog" }));
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
            restoreMeasurements();
        }
    }
);
