import {
    calendarEndTimestamp,
    type CalendarEvent,
    type CalendarInput,
} from "@homelab/contracts/miraCalendar";
import {
    ActionGroup,
    Button,
    DatePicker,
    DateTimePicker,
    dateTimePickerTimestamp,
    ErrorNotice,
    Fieldset,
    FormField,
    Input,
    Modal,
    Switch,
    Textarea,
} from "@homelab/ui";
import { CalendarDays } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { floatingDay } from "./calendarDays";
import { calendarEditorDraft } from "./calendarEditorDraft";
import { reminderInstant, reminderSelection } from "./calendarReminder";
import { CalendarReminderField } from "./CalendarReminderField";

const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Create, edit or remove an appointment using the shared dashboard controls.
 * @param props - Selected day, optional existing revision, and close action.
 * @returns An event editor with explicit deletion and interval validation.
 */
export function CalendarEditor({
    day,
    event: initialEvent,
    onClose,
}: {
    day: Date;
    event?: CalendarEvent | undefined;
    onClose: () => void;
}) {
    // Keep the revision the operator opened while background calendar reads refresh.
    const [draft] = useState(() => calendarEditorDraft(day, initialEvent));
    const target = draft.target;
    const [checkedAt, setCheckedAt] = useState(Date.now);
    const [title, setTitle] = useState(draft.title);
    const [location, setLocation] = useState(draft.location);
    const [notes, setNotes] = useState(draft.notes);
    const [allDay, setAllDay] = useState(draft.allDay);
    const [start, setStart] = useState(draft.start);
    const [end, setEnd] = useState(draft.end);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // Preserve the saved instant when only another field changes, including the repeated hour in autumn.
    const timedStart =
        start === draft.start && !draft.allDay
            ? start.date.getTime()
            : dateTimePickerTimestamp(start);
    const timedEnd =
        end === draft.end && !draft.allDay
            ? end.date.getTime()
            : dateTimePickerTimestamp(end);
    const from = allDay ? floatingDay(start.date) : timedStart;
    const until = allDay ? floatingDay(end.date) + 86_400_000 : timedEnd;
    function boundary(value: number) {
        if (!allDay || !Number.isFinite(value)) return value;
        return calendarEndTimestamp({
            allDay,
            endsAt: new Date(value).toISOString(),
            timeZone: draft.timeZone,
        });
    }
    const localStart = boundary(from);
    const localEnd = boundary(until);
    const [operator, setOperator] = useState(() =>
        reminderSelection(draft.operatorReminderAt, localStart, draft.timeZone)
    );
    const [mira, setMira] = useState(() =>
        reminderSelection(draft.miraReminderAt, localStart, draft.timeZone)
    );
    const operatorAt = reminderInstant(operator, localStart, draft.timeZone);
    const miraAt = reminderInstant(mira, localStart, draft.timeZone);
    function reminderError(
        at: number | null,
        recipient: "operator" | "mira",
        now = checkedAt
    ) {
        if (at === null) return null;
        if (!Number.isFinite(at)) return "Choose a valid reminder time.";
        if (allDay && recipient === "mira" && at >= localEnd)
            return "Choose a time before this all-day event ends.";
        if (at > localEnd) return "Choose a time on or before the event ends.";
        const saved =
            recipient === "mira" ? draft.miraReminderAt : draft.operatorReminderAt;
        if (at < now && !(saved && Date.parse(saved) === at))
            return "Choose a reminder time in the future.";
        return null;
    }
    const operatorError = reminderError(operatorAt, "operator");
    const miraError = reminderError(miraAt, "mira");
    const validInterval = Number.isFinite(from) && Number.isFinite(until) && until > from;
    const valid = validInterval && !operatorError && !miraError;
    const save = useOperation(
        (input: CalendarInput, signal) =>
            target
                ? api.mira.calendar.update.mutate({ ...input, ...target }, { signal })
                : api.mira.calendar.create.mutate(input, { signal }),
        onClose
    );
    const remove = useOperation(
        (saved: NonNullable<typeof target>, signal) =>
            api.mira.calendar.delete.mutate(saved, { signal }),
        onClose
    );
    const pending = save.isPending || remove.isPending;
    const editorTitle = target ? "Edit event" : "New event";
    return (
        <Modal
            title={confirmDelete ? "Delete event" : editorTitle}
            {...(confirmDelete
                ? {}
                : {
                      description:
                          viewerTimeZone === draft.timeZone
                              ? `Times shown in ${viewerTimeZone}.`
                              : `Times shown in ${viewerTimeZone}. Event time zone: ${draft.timeZone}.`,
                  })}
            icon={CalendarDays}
            size={confirmDelete ? "md" : "wide"}
            onClose={onClose}
            dismissible={!pending}
        >
            {confirmDelete && target ? (
                <div className="space-y-4">
                    <p className="text-sm wrap-anywhere text-primary-200">
                        Remove <strong>{draft.title}</strong> from the shared calendar?
                    </p>
                    {remove.error && <ErrorNotice error={remove.error} />}
                    <ActionGroup>
                        <Button
                            variant="secondary"
                            disabled={pending}
                            onClick={() => setConfirmDelete(false)}
                        >
                            Keep event
                        </Button>
                        <Button
                            variant="danger"
                            busy={remove.isPending}
                            onClick={() => remove.mutate(target)}
                        >
                            Delete event
                        </Button>
                    </ActionGroup>
                </div>
            ) : (
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const now = Date.now();
                        if (
                            reminderError(operatorAt, "operator", now) ||
                            reminderError(miraAt, "mira", now)
                        ) {
                            setCheckedAt(now);
                            return;
                        }
                        if (valid && title.trim())
                            save.mutate({
                                title,
                                location,
                                notes,
                                allDay,
                                timeZone: draft.timeZone,
                                startsAt: new Date(from).toISOString(),
                                endsAt: new Date(until).toISOString(),
                                operatorReminderAt:
                                    operatorAt === null
                                        ? null
                                        : new Date(operatorAt).toISOString(),
                                miraReminderAt:
                                    miraAt === null
                                        ? null
                                        : new Date(miraAt).toISOString(),
                            });
                    }}
                >
                    <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <FormField label="Event title">
                            <Input
                                required
                                maxLength={160}
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                            />
                        </FormField>
                        <div className="flex min-h-10 items-center">
                            <Switch
                                label="All day"
                                checked={allDay}
                                onChange={setAllDay}
                            />
                        </div>
                    </div>
                    {allDay ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            <DatePicker
                                label="First day"
                                value={start.date}
                                onChange={(date) => setStart({ ...start, date })}
                            />
                            <DatePicker
                                label="Last day"
                                minimumDate={start.date}
                                value={end.date}
                                onChange={(date) => setEnd({ ...end, date })}
                            />
                        </div>
                    ) : (
                        <div className="grid gap-4 lg:grid-cols-2">
                            <DateTimePicker
                                label="Starts"
                                value={start}
                                onChange={setStart}
                            />
                            <DateTimePicker label="Ends" value={end} onChange={setEnd} />
                        </div>
                    )}
                    {!validInterval && (
                        <p role="alert" className="text-sm text-amber-300">
                            Choose an end after the start.
                        </p>
                    )}
                    <Fieldset legend="Reminders">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <CalendarReminderField
                                label="Notify me"
                                description="Sends a dashboard notification."
                                selection={operator}
                                onChange={setOperator}
                                error={operatorError ?? undefined}
                            />
                            <CalendarReminderField
                                label="Wake Mira"
                                description="Starts a chat when automatic work is enabled."
                                selection={mira}
                                onChange={setMira}
                                error={miraError ?? undefined}
                            />
                        </div>
                    </Fieldset>
                    <FormField label="Location">
                        <Input
                            maxLength={240}
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                        />
                    </FormField>
                    <FormField label="Notes">
                        <Textarea
                            maxLength={8000}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                        />
                    </FormField>
                    {save.error && <ErrorNotice error={save.error} />}
                    <ActionGroup>
                        {target ? (
                            <Button
                                variant="danger"
                                disabled={pending}
                                onClick={() => setConfirmDelete(true)}
                            >
                                Delete event
                            </Button>
                        ) : (
                            <Button
                                variant="secondary"
                                disabled={pending}
                                onClick={onClose}
                            >
                                Cancel
                            </Button>
                        )}
                        <Button
                            type="submit"
                            busy={save.isPending}
                            disabled={!valid || !title.trim()}
                        >
                            Save event
                        </Button>
                    </ActionGroup>
                </form>
            )}
        </Modal>
    );
}
