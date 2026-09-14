import { Card } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function ActivityPanel({ data }: AccountPanelProps) {
    return (
        <Card id="security-activity" className="space-y-4">
            <h2 className="text-xl font-semibold">Security activity</h2>
            <ul className="divide-y divide-slate-200">
                {data.events.map((event) => (
                    <li
                        key={event.id}
                        className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                    >
                        <span>{event.event.replaceAll("_", " ")}</span>
                        <time className="text-slate-600" dateTime={event.createdAt}>
                            {new Date(event.createdAt).toLocaleString()}
                        </time>
                    </li>
                ))}
            </ul>
        </Card>
    );
}
