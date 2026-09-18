import { expect, test } from "bun:test";

import { formatMetric, utilization } from "./formatMetric";

test("formats base units consistently and preserves zero", () => {
    expect(formatMetric(null)).toBe("Not reported");
    expect(formatMetric(Number.NaN)).toBe("Not reported");
    expect(formatMetric(0, "bytes")).toBe("0 B");
    expect(formatMetric(1024, "bytes")).toBe("1 KiB");
    expect(formatMetric(2 ** 30, "bytes/s")).toBe("1 GiB/s");
    expect(formatMetric(2_500_000_000, "bits/s")).toBe("2.5 Gbit/s");
    expect(formatMetric(31, "celsius")).toBe("31 °C");
    expect(formatMetric(12.55, "percent")).toBe("12.6%");
    expect(formatMetric(90_000, "seconds")).toBe("1d 1h");
    expect(formatMetric(3660, "seconds")).toBe("1h 1m");
    expect(formatMetric(120, "seconds")).toBe("2m");
    expect(utilization(0, 100)).toBe(0);
    expect(utilization(50, 100)).toBe(50);
    expect(utilization(10, 0)).toBeNull();
    expect(utilization(null, 10)).toBeNull();
});
