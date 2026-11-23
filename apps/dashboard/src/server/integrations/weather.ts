import * as v from "valibot";

import { readBoundedJson } from "./http/readJson";

// Use the homelab location shared by the previous dashboard, independent of the browser's location.
const url = new URL("https://api.open-meteo.com/v1/forecast");
url.search = new URLSearchParams({
    latitude: "59.62",
    longitude: "11.08",
    timezone: "Europe/Oslo",
    current: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_min,temperature_2m_max",
    forecast_days: "4",
}).toString();

const number = v.pipe(v.number(), v.finite());
const dates = v.pipe(v.array(v.pipe(v.string(), v.isoDate())), v.length(4));
const readings = v.pipe(v.array(number), v.length(4));
const schema = v.object({
    current: v.object({
        temperature_2m: number,
        weather_code: number,
        is_day: v.picklist([0, 1]),
    }),
    daily: v.object({
        time: dates,
        weather_code: readings,
        temperature_2m_min: readings,
        temperature_2m_max: readings,
    }),
});

async function forecast() {
    const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
    });
    const { current, daily } = v.parse(
        schema,
        await readBoundedJson(response, 64 * 1024)
    );
    return {
        location: "Spydeberg",
        temperature: current.temperature_2m,
        code: current.weather_code,
        daylight: Boolean(current.is_day),
        fetchedAt: Date.now(),
        days: daily.time.map((date, i) => ({
            date,
            code: daily.weather_code[i]!,
            low: daily.temperature_2m_min[i]!,
            high: daily.temperature_2m_max[i]!,
        })),
    };
}

let cached: { until: number; value: ReturnType<typeof forecast> } | undefined;

/** Share the Spydeberg forecast across dashboard sessions and coalesce simultaneous refreshes.
 * @returns The current temperature and four local forecast dates from Open-Meteo.
 */
export function readOverviewWeather() {
    if (cached && Date.now() < cached.until) return cached.value;
    const entry = { until: Date.now() + 15 * 60_000, value: forecast() };
    cached = entry;
    void entry.value.catch(() => {
        entry.until = Date.now() + 30_000;
    });
    return entry.value;
}
