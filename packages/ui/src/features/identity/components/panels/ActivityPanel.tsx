import { History } from "lucide-react";

import { Card, SectionHeader } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function ActivityPanel({ data }: AccountPanelProps) {
    return (
        <Card id="security-activity" className="space-y-4">
            <SectionHeader
                title="Security activity"
                description="Recent changes and sign-in events for your account."
                icon={History}
            />
            <ul className="divide-y divide-primary-700">
                {data.events.map((event) => (
                    <li
                        key={event.id}
                        className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                    >
                        <span>{event.event.replaceAll("_", " ")}</span>
                        <time className="text-primary-300" dateTime={event.createdAt}>
                            {new Date(event.createdAt).toLocaleString()}
                        </time>
                    </li>
                ))}
            </ul>
        </Card>
    );
}
