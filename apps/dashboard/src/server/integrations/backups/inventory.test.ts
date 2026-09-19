import { expect, test } from "bun:test";

import type { MetricSamples } from "../metrics/samples";
import { backupInventory } from "./inventory";

function metrics(values: Record<string, number | null>, up = 1): MetricSamples {
    return {
        up: [{ labels: { host: "backup", job: "node" }, value: up }],
        ...Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
                `homelab_backup_${name}`,
                [{ labels: { host: "backup", task: "vm-100" }, value }],
            ])
        ),
    };
}
const healthy = {
    history_known: 1,
    last_completed_success: 1,
    last_success_timestamp_seconds: 1000,
    last_failure_timestamp_seconds: 0,
    max_age_seconds: 100,
};

test("backup interpretation separates failed, stale, disabled, running and unknown tasks", () => {
    expect(backupInventory(metrics(healthy), null, 1050).backups[0]?.state).toBe(
        "healthy"
    );
    expect(backupInventory(metrics(healthy), null, 1100).backups[0]?.state).toBe(
        "healthy"
    );
    expect(backupInventory(metrics(healthy), null, 1101).backups[0]?.state).toBe(
        "overdue"
    );
    for (const [change, expected] of [
        [{ current_failed: 1 }, "failed"],
        [{ last_completed_success: 0 }, "failed"],
        [{ current_running: 1 }, "running"],
        [{ timer_enabled: 0 }, "disabled"],
        [{ timer_active: 0 }, "disabled"],
        [{ history_known: 0 }, "unknown"],
        [{ last_success_timestamp_seconds: 0 }, "unknown"],
        [{ last_success_timestamp_seconds: 9000 }, "unknown"],
        [{ max_age_seconds: 0 }, "unknown"],
    ] as const)
        expect(
            backupInventory(metrics({ ...healthy, ...change }), null, 1050).backups[0]
                ?.state
        ).toBe(expected);
});

test("backup outages retain identities but never retain healthy historical measurements", () => {
    const previous = backupInventory(metrics(healthy), null, 1050);
    const unavailable = backupInventory(
        { up: [{ labels: { host: "backup", job: "node" }, value: 0 }] },
        previous,
        1100
    );
    expect(unavailable.backups).toHaveLength(1);
    expect(unavailable.backups[0]).toMatchObject({
        state: "unknown",
        lastSuccessAt: null,
        maximumAgeSeconds: null,
    });
    expect(
        backupInventory(
            { up: [{ labels: { host: "backup", job: "node" }, value: 1 }] },
            previous,
            1100
        ).backups
    ).toHaveLength(0);
    expect(
        backupInventory(metrics({ ...healthy, max_age_seconds: Number.NaN }), null, 1050)
            .backups[0]?.state
    ).toBe("unknown");
});
