import type { ScheduleSummary } from "@homelab/contracts/operations";
import { DropdownMenu, ErrorNotice } from "@homelab/ui";
import { CalendarClock, Pause, Play, Pencil } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { DisableScheduleDialog } from "./DisableScheduleDialog";
import { ScheduleDialog } from "./ScheduleDialog";

/**
 * Group a schedule's manual run, editing and disable intent actions.
 * @returns A compact menu with version-stable dialogs and idempotent manual submissions.
 */
export function ScheduleActions({ schedule }: { readonly schedule: ScheduleSummary }) {
    const [dialog, setDialog] = useState<{
        kind: "edit" | "disable";
        schedule: ScheduleSummary;
    }>();
    const [requestId, setRequestId] = useState(() => crypto.randomUUID());
    const run = useOperation((id: string, signal) =>
        api.jobs.run.mutate({ action: schedule.action, requestId: id }, { signal })
    );
    const enable = useOperation((version: number, signal) =>
        api.schedules.setEnabled.mutate(
            { id: schedule.id, version, enabled: true, reason: null, until: null },
            { signal }
        )
    );
    return (
        <div className="space-y-2">
            <DropdownMenu
                label={`Actions for ${schedule.label}`}
                disabled={run.isPending || enable.isPending}
                actions={[
                    {
                        id: "run",
                        label: "Run now",
                        icon: Play,
                        disabled:
                            !schedule.manualRunAvailable || Boolean(schedule.activeRun),
                        onSelect: () =>
                            run.mutate(requestId, {
                                onSuccess: () => setRequestId(crypto.randomUUID()),
                            }),
                    },
                    {
                        id: "edit",
                        label: "Edit schedule",
                        icon: CalendarClock,
                        onSelect: () => setDialog({ kind: "edit", schedule }),
                    },
                    {
                        id: "toggle",
                        label: schedule.enabled ? "Disable schedule" : "Enable schedule",
                        icon: schedule.enabled ? Pause : Play,
                        onSelect: () => {
                            if (schedule.enabled)
                                setDialog({ kind: "disable", schedule });
                            else enable.mutate(schedule.version);
                        },
                    },
                    ...(schedule.enabled
                        ? []
                        : [
                              {
                                  id: "reason",
                                  label: "Edit disable reason",
                                  icon: Pencil,
                                  onSelect: () =>
                                      setDialog({ kind: "disable", schedule }),
                              },
                          ]),
                ]}
            />
            {run.isError && <ErrorNotice error={run.error} />}
            {enable.isError && <ErrorNotice error={enable.error} />}
            {dialog?.kind === "edit" && (
                <ScheduleDialog
                    schedule={dialog.schedule}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog?.kind === "disable" && (
                <DisableScheduleDialog
                    schedule={dialog.schedule}
                    onClose={() => setDialog(undefined)}
                />
            )}
        </div>
    );
}
