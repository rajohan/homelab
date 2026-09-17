import { expect, mock, test } from "bun:test";

import type { JobSummary, ScheduleSummary } from "@homelab/contracts/operations";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { DisableScheduleDialog } from "./DisableScheduleDialog";
import { JobHistory } from "./JobHistory";
import { JobRunTable } from "./JobRunTable";
import { JobStatus } from "./JobStatus";
import { ScheduleActions } from "./ScheduleActions";
import { ScheduleDialog } from "./ScheduleDialog";
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

test("worker view includes zero counts and explains pause without treating it as failure", async () => {
    const cleanup = fixture(<WorkerPanel />, (query) =>
        query.setQueryData(["operations", "worker"], {
            workers: [],
            counts: [],
            oldestQueuedAt: null,
            control: {
                paused: true,
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
        await user.click(screen.getByRole("button", { name: "Resume worker" }));
        expect(screen.getByRole("dialog", { name: "Resume worker?" })).toBeVisible();
        expect(screen.getByText(/Missed schedule occurrences/)).toBeVisible();
    } finally {
        cleanup();
    }
});

test("schedule history opens in a modal without duplicate details or a second scroll container", async () => {
    const cleanup = fixture(<ScheduleActions schedule={schedule} />, (query) => {
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
        await user.click(screen.getByRole("menuitem", { name: "History" }));
        const dialog = screen.getByRole("dialog", { name: "History" });
        expect(dialog).toBeVisible();
        expect(screen.queryByText(/Next run:/)).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: "Run history" })
        ).not.toBeInTheDocument();
        expect(dialog.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
