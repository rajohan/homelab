import { expect, test } from "bun:test";

import { chartData } from "./chartData";
import { chartValueAxis } from "./chartValueAxis";

test("aligns series without turning gaps into zeros or mutating input", () => {
    const input = [
        {
            key: "read",
            label: "Read",
            points: [
                { time: 3, value: 3 },
                { time: 1, value: 0 },
            ],
        },
        {
            key: "write",
            label: "Written",
            points: [
                { time: 2, value: null },
                { time: 3, value: 7 },
            ],
        },
    ];
    expect(chartData(input)).toEqual([
        { time: 1, read: 0, write: null },
        { time: 2, read: null, write: null },
        { time: 3, read: 3, write: 7 },
    ]);
    expect(input[0]?.points[0]?.time).toBe(3);
    expect(chartData([])).toEqual([]);
});

test("capacity axes end exactly at the measured ceiling and preserve larger historical values", () => {
    const series = [
        { key: "used", label: "Used", points: [{ time: 1, value: 2 * 1024 ** 3 }] },
        {
            key: "capacity",
            label: "Capacity",
            points: [{ time: 1, value: 4 * 1024 ** 3 }],
        },
    ];
    expect(chartValueAxis(series, "capacity")).toEqual({
        domain: [0, 4 * 1024 ** 3],
        ticks: [0, 1, 2, 3, 4].map((value) => value * 1024 ** 3),
    });
    series[1]?.points.push({ time: 0, value: 8 * 1024 ** 3 });
    expect(chartValueAxis(series, "capacity").domain).toEqual([0, 8 * 1024 ** 3]);
    series[0]?.points.push({ time: 0, value: 9 * 1024 ** 3 });
    expect(chartValueAxis(series, "capacity").domain).toEqual([0, 9 * 1024 ** 3]);
});

test("missing capacity retains automatic scaling without treating missing data as zero", () => {
    expect(chartValueAxis([], "capacity")).toEqual({
        domain: [0, "auto"],
        ticks: undefined,
    });
    const series = [
        { key: "capacity", label: "Capacity", points: [{ time: 1, value: null }] },
    ];
    expect(chartValueAxis(series, "capacity").domain).toEqual([0, "auto"]);
    expect(chartValueAxis(series).domain).toEqual([0, "auto"]);
});
