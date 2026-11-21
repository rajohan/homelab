import { Clock3 } from "lucide-react";

import { Select } from "./Select";

/** Choose among the time windows supported by the current history or log source.
 * @returns A compact time-range control that exposes the selected window and keyboard navigation.
 */
export function TimeRangeSelect<T extends string>({
    ranges,
    value,
    onChange,
}: {
    readonly ranges: readonly T[];
    readonly value: T;
    readonly onChange: (value: T) => void;
}) {
    return (
        <Select
            label="Time range"
            compact
            icon={Clock3}
            value={value}
            onChange={onChange}
            options={ranges.map((range) => ({ value: range, label: `Last ${range}` }))}
        />
    );
}
