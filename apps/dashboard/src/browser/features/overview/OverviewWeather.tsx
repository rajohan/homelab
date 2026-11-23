import { Button, Modal } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import {
    ChevronDown,
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudMoon,
    CloudRain,
    CloudSun,
    Moon,
    Snowflake,
    Sun,
} from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";

function condition(code: number, day = true) {
    if (code === 0) return { label: "Clear", Icon: day ? Sun : Moon };
    if (code === 1 || code === 2)
        return { label: "Partly cloudy", Icon: day ? CloudSun : CloudMoon };
    if (code === 3) return { label: "Overcast", Icon: Cloud };
    if (code === 45 || code === 48) return { label: "Fog", Icon: CloudFog };
    if ([51, 53, 55, 56, 57].includes(code))
        return { label: "Drizzle", Icon: CloudDrizzle };
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code))
        return { label: "Rain", Icon: CloudRain };
    if ([71, 73, 75, 77, 85, 86].includes(code))
        return { label: "Snow", Icon: Snowflake };
    if ([95, 96, 99].includes(code))
        return { label: "Thunderstorms", Icon: CloudLightning };
    return { label: "Conditions unavailable", Icon: Cloud };
}
const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    weekday: "long",
    day: "numeric",
    month: "short",
});
const temperature = (value: number) => `${Math.round(value)}°`;

/** Open today's conditions and the following three days without leaving Overview.
 * @returns A compact forecast button and its accessible detail dialog.
 */
export function OverviewWeather() {
    const [open, setOpen] = useState(false);
    const query = useQuery({
        queryKey: ["system", "weather"],
        queryFn: ({ signal }) => api.system.weather.query(undefined, { signal }),
        staleTime: 15 * 60_000,
        refetchInterval: 15 * 60_000,
        retry: false,
    });
    const weather = query.data;
    const fallback = query.isPending ? "Weather…" : "Weather unavailable";
    const current = weather
        ? condition(weather.code, weather.daylight)
        : { label: "Weather", Icon: Cloud };
    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label="View Spydeberg weather forecast"
                onClick={() => setOpen(true)}
            >
                <current.Icon size={17} className="text-accent-300" aria-hidden="true" />
                {weather ? `${temperature(weather.temperature)}C` : fallback}
                <ChevronDown size={13} aria-hidden="true" />
            </Button>
            {open && (
                <Modal
                    title="Spydeberg weather"
                    icon={current.Icon}
                    onClose={() => setOpen(false)}
                    footer={
                        <a
                            className="text-sm text-accent-300 underline"
                            href="https://open-meteo.com/"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Weather data by Open-Meteo
                        </a>
                    }
                >
                    {weather && (
                        <div className="space-y-4">
                            <p className="flex flex-wrap items-baseline gap-x-3">
                                <strong className="text-3xl font-semibold tabular-nums">
                                    {temperature(weather.temperature)}C
                                </strong>
                                <span className="text-primary-300">{current.label}</span>
                            </p>
                            <ul className="divide-y divide-primary-700 rounded-lg border border-primary-700 bg-surface-card px-3">
                                {weather.days.map((row) => {
                                    const { Icon, label } = condition(row.code);
                                    return (
                                        <li
                                            key={row.date}
                                            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
                                        >
                                            <Icon
                                                size={18}
                                                className="shrink-0 text-accent-300"
                                                aria-hidden="true"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-medium">
                                                    {weekday.format(
                                                        new Date(row.date + "T12:00:00Z")
                                                    )}
                                                </p>
                                                <p className="text-xs text-primary-400">
                                                    {label}
                                                </p>
                                            </div>
                                            <span className="text-sm whitespace-nowrap tabular-nums">
                                                <span className="sr-only">Low </span>
                                                {temperature(row.low)}
                                                <span className="text-primary-400">
                                                    {" "}
                                                    /{" "}
                                                </span>
                                                <span className="sr-only">High </span>
                                                {temperature(row.high)}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                    {query.isPending && <output>Loading forecast…</output>}
                    {query.isError && (
                        <div className="flex flex-wrap items-center gap-2">
                            <output>
                                {weather
                                    ? "Showing the last available forecast."
                                    : "The forecast is temporarily unavailable."}
                            </output>
                            <Button
                                variant="secondary"
                                size="sm"
                                busy={query.isFetching}
                                onClick={() => void query.refetch()}
                            >
                                Retry
                            </Button>
                        </div>
                    )}
                </Modal>
            )}
        </>
    );
}
