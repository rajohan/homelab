import { formatDateTimeParts } from "../../lib/formatDateTime";

/**
 * Keep the date and time of an observation legible in a narrow column.
 * @returns A semantic timestamp formatted in the viewer's local timezone.
 */
export function Timestamp({ value }: { readonly value: string }) {
    const [date, time] = formatDateTimeParts(value);
    return (
        <time dateTime={value} className="inline-grid leading-5 tabular-nums">
            <span>{date}</span>
            <span className="text-xs text-primary-400">{time}</span>
        </time>
    );
}
