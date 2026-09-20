import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable } from "./DataTable";

test.each(["actions", "footer-actions"] as const)(
    "compact rows keep %s independent from the keyboard-accessible details surface",
    async (mobile) => {
        const select = mock(() => {});
        const stop = mock(() => {});
        const row = { id: "job-1", name: "Scheduled work" };
        const view = render(
            <div
                ref={(element) => {
                    const tableViewport = element?.querySelector("section");
                    if (tableViewport)
                        Object.defineProperties(tableViewport, {
                            offsetHeight: { value: 520, configurable: true },
                            offsetWidth: { value: 960, configurable: true },
                        });
                }}
            >
                <DataTable
                    label="Example jobs"
                    compact
                    rows={[row]}
                    getKey={(item) => item.id}
                    rowAction={{ label: (item) => `Open ${item.name}`, onSelect: select }}
                    columns={[
                        {
                            id: "name",
                            label: "Name",
                            mobile: "title",
                            render: (item) => item.name,
                        },
                        { id: "status", label: "Status", render: () => "Running" },
                        { id: "size", label: "Work size", render: () => "Light" },
                        {
                            id: "actions",
                            label: "Actions",
                            mobile,
                            hideLabel: true,
                            width: "w-16",
                            render: () => (
                                <button type="button" onClick={stop}>
                                    Stop job
                                </button>
                            ),
                        },
                    ]}
                />
            </div>
        );
        try {
            const user = userEvent.setup();
            const surface = screen.getByRole("button", { name: "Open Scheduled work" });
            await user.click(surface);
            expect(select).toHaveBeenCalledWith(row);
            await user.keyboard("{Enter}");
            expect(select).toHaveBeenCalledTimes(2);
            await user.click(screen.getByRole("button", { name: "Stop job" }));
            expect(stop).toHaveBeenCalledTimes(1);
            expect(select).toHaveBeenCalledTimes(2);
            expect(screen.getByText("Scheduled work").closest("tr")).toHaveClass(
                "@max-[48rem]:grid-cols-2",
                "isolate"
            );
            const actionHeader = screen.getByRole("columnheader", { name: "Actions" });
            expect(actionHeader).toHaveClass("w-16");
            expect(actionHeader.querySelector("span")).toHaveClass("sr-only");
            expect(actionHeader.closest("thead")).toHaveClass(
                "sticky",
                "z-10",
                "bg-primary-900"
            );
            expect(screen.getByRole("region", { name: "Example jobs" })).toHaveClass(
                "isolate",
                "scrollbar-gutter-stable"
            );
            const actionButton = screen.getByRole("button", { name: "Stop job" });
            const actionCell = actionButton.closest("td");
            expect(actionButton.parentElement).not.toHaveClass("pointer-events-none");
            expect(actionCell).toHaveClass("text-right");
            if (mobile === "footer-actions") {
                expect(actionCell).toHaveClass(
                    "@max-[48rem]:order-last",
                    "@max-[48rem]:col-span-2"
                );
                expect(actionCell).not.toHaveClass(
                    "@max-[48rem]:row-start-1",
                    "@max-[48rem]:justify-self-end"
                );
                expect(screen.getByText("Scheduled work").closest("td")).toHaveClass(
                    "@max-[48rem]:col-span-2"
                );
            } else {
                expect(actionCell).toHaveClass(
                    "@max-[48rem]:row-start-1",
                    "@max-[48rem]:justify-self-end"
                );
                expect(actionCell).not.toHaveClass("@max-[48rem]:order-last");
            }
        } finally {
            view.unmount();
        }
    }
);
