import { expect, test } from "bun:test";

import { collectMetrics } from "../integrations/metrics/collector";
import { queryMetrics } from "../integrations/metrics/transport";
import { createMonitoringFixture } from "../testing/monitoring";

test("isolated preview serves aggregate metrics without mixing backup series into counts", async () => {
    const fixture = createMonitoringFixture();
    const configuration = { url: fixture.url, token: undefined };
    try {
        expect(
            await collectMetrics(configuration, AbortSignal.timeout(5000))
        ).toMatchObject({
            reachableTargets: 1,
            totalTargets: 1,
            firingAlerts: 1,
        });
        const backups = await queryMetrics(
            configuration,
            '{__name__=~"homelab_backup_.*"}',
            AbortSignal.timeout(5000)
        );
        expect(backups.resultType).toBe("vector");
        expect(
            backups.result.some(
                (sample) => sample.metric.__name__ === "homelab_backup_current_failed"
            )
        ).toBe(true);
    } finally {
        await fixture.close();
    }
});
