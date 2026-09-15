import { History } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";
/**
 * List recent account security events from the authenticated account snapshot.
 * @returns The component's rendered content for its current state.
 */
export function ActivityPanel({ data }: AccountPanelProps) {
    const [expanded, setExpanded] = useState(false);
    const events = expanded ? data.events : data.events.slice(0, 10);
    return (
        <SettingsSection
            id="security-activity"
            title="Security activity"
            description="Recent changes and sign-in events for your account."
            icon={History}
        >
            {data.events.length === 0 && (
                <p className="text-sm text-primary-400">No recent security activity.</p>
            )}
            <ul className="divide-y divide-primary-700">
                {events.map((event) => (
                    <li
                        key={event.id}
                        className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                    >
                        <span className="first-letter:uppercase">
                            {event.event.replaceAll("_", " ")}
                        </span>
                        <time className="text-primary-300" dateTime={event.createdAt}>
                            {new Date(event.createdAt).toLocaleString()}
                        </time>
                    </li>
                ))}
            </ul>
            {data.events.length > 10 && (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                >
                    {expanded
                        ? "Show fewer events"
                        : `Show all ${data.events.length} events`}
                </Button>
            )}
        </SettingsSection>
    );
}
