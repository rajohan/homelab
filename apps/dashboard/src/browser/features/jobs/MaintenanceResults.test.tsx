import { expect, test } from "bun:test";

import { render, screen, cleanup } from "@testing-library/react";

import { MaintenanceResults } from "./MaintenanceResults";
import { RunProgress } from "./RunProgress";

test("a quiet long-running update shows elapsed time and liveness without claiming it is stuck", () => {
    try {
        render(
            <RunProgress
                run={{
                    state: "running",
                    startedAt: new Date(Date.now() - 370_000).toISOString(),
                    finishedAt: null,
                    message: "Installing the approved version.",
                    lastProgressAt: new Date(Date.now() - 300_000).toISOString(),
                    responding: true,
                }}
            />
        );
        expect(screen.getByText(/Elapsed: 6m/)).toBeVisible();
        expect(screen.getByText("Installing the approved version.")).toBeVisible();
        expect(screen.getByText(/Worker responding/)).toBeVisible();
        expect(screen.queryByText(/stuck|failed/i)).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("maintenance receipts distinguish verified health, skipped probes and remaining restarts", () => {
    try {
        render(
            <MaintenanceResults
                results={[
                    {
                        label: "Web",
                        operation: "update",
                        installed: "2.0.1",
                        health: "passed",
                        rebootRequired: true,
                        warnings: ["Review the application's update report."],
                    },
                    {
                        label: "Stopped service",
                        operation: "update",
                        installed: "1.0.2",
                        health: "preserved-stopped",
                        rebootRequired: null,
                        warnings: [],
                    },
                ]}
            />
        );
        expect(screen.getByText("Installed: 2.0.1")).toBeVisible();
        expect(screen.getByText("Health: Passed")).toBeVisible();
        expect(screen.getByText("Host restart: Still required")).toBeVisible();
        expect(
            screen.getByText("Health: Previously stopped; left stopped")
        ).toBeVisible();
        expect(screen.getByText("Host restart: Unknown")).toBeVisible();
        expect(screen.getByText(/additional, unverified changes/)).toBeVisible();
    } finally {
        cleanup();
    }
});
