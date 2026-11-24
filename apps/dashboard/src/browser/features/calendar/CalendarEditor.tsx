import type { CalendarEvent, CalendarInput } from "@homelab/contracts/miraCalendar";
import {
    ActionGroup,
    Button,
    DatePicker,
    DateTimePicker,
    dateTimePickerTimestamp,
    dateTimePickerValue,
    ErrorNotice,
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
import { floatingDay, localDay } from "./calendarDays";

/** Create, edit or remove an appointment using the shared dashboard controls.
 * @param props - Selected day, optional existing revision, and close action.
 * @returns An event editor with explicit deletion and interval validation.
 */
export function CalendarEditor({
    day,
    event,
    onClose,
}: {
    day: Date;
    event?: CalendarEvent | undefined;
    onClose: () => void;
}) {
    const initial = new Date(day);
    initial.setHours(9, 0, 0, 0);
    const [title, setTitle] = useState(event?.title ?? "");
    const [location, setLocation] = useState(event?.location ?? "");
    const [notes, setNotes] = useState(event?.notes ?? "");
    const [allDay, setAllDay] = useState(event?.allDay ?? false);
    const [start, setStart] = useState(() => {
        if (event?.allDay)
            return dateTimePickerValue(localDay(Date.parse(event.startsAt)));
        return dateTimePickerValue(event?.startsAt ?? initial);
    });
    const [end, setEnd] = useState(() => {
        if (event?.allDay)
            return dateTimePickerValue(localDay(Date.parse(event.endsAt) - 86_400_000));
        return dateTimePickerValue(event?.endsAt ?? initial.getTime() + 3_600_000);
    });
    const [confirmDelete, setConfirmDelete] = useState(false);
    const from = allDay ? floatingDay(start.date) : dateTimePickerTimestamp(start);
    const until = allDay
        ? floatingDay(end.date) + 86_400_000
        : dateTimePickerTimestamp(end);
    const valid = Number.isFinite(from) && Number.isFinite(until) && until > from;
    const save = useOperation(
        (input: CalendarInput, signal) =>
            event
                ? api.mira.calendar.update.mutate(
                      { ...input, id: event.id, version: event.version },
                      { signal }
                  )
                : api.mira.calendar.create.mutate(input, { signal }),
        onClose
    );
    const remove = useOperation(
        (_input: void, signal) =>
            api.mira.calendar.delete.mutate(
                { id: event!.id, version: event!.version },
                { signal }
            ),
        onClose
    );
    const pending = save.isPending || remove.isPending;
    const editorTitle = event ? "Edit event" : "New event";
    return (
        <Modal
            title={confirmDelete ? "Delete event" : editorTitle}
            icon={CalendarDays}
            onClose={onClose}
            dismissible={!pending}
        >
            {confirmDelete ? (
                <div className="space-y-4">
                    <p className="text-sm wrap-anywhere text-primary-200">
                        Remove <strong>{event?.title}</strong> from the shared calendar?
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
                            onClick={() => remove.mutate()}
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
                        if (valid && title.trim())
                            save.mutate({
                                title,
                                location,
                                notes,
                                allDay,
                                startsAt: new Date(from).toISOString(),
                                endsAt: new Date(until).toISOString(),
                            });
                    }}
                >
                    <FormField label="Event title">
                        <Input
                            required
                            maxLength={160}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </FormField>
                    <Switch label="All day" checked={allDay} onChange={setAllDay} />
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
                        <>
                            <DateTimePicker
                                label="Starts"
                                value={start}
                                onChange={setStart}
                            />
                            <DateTimePicker label="Ends" value={end} onChange={setEnd} />
                        </>
                    )}
                    {!valid && (
                        <p role="alert" className="text-sm text-amber-300">
                            Choose an end after the start.
                        </p>
                    )}
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
                        {event ? (
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
