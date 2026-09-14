import { describe, expect, test } from "bun:test";

import { VerificationCoordinator } from "./verificationCoordinator";

describe("automatic security verification coordination", () => {
    test("shares one prompt and resumes all explicitly blocked operations", async () => {
        const coordinator = new VerificationCoordinator();
        const first = coordinator.request(),
            second = coordinator.request();
        const generation = coordinator.getSnapshot();
        expect(generation).toBeGreaterThan(0);
        coordinator.complete(generation);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(coordinator.getSnapshot()).toBe(0);
    });
    test("cancellation rejects pending replay and ignores a late proof", async () => {
        const coordinator = new VerificationCoordinator();
        const first = coordinator.request();
        const stale = coordinator.getSnapshot();
        coordinator.cancel();
        expect(await first).toBe(false);
        const second = coordinator.request();
        const current = coordinator.getSnapshot();
        coordinator.complete(stale);
        expect(coordinator.getSnapshot()).toBe(current);
        coordinator.complete(current);
        expect(await second).toBe(true);
    });
    test("one aborted operation does not resume or cancel other waiters", async () => {
        const coordinator = new VerificationCoordinator();
        const abort = new AbortController();
        const first = coordinator.request(abort.signal),
            second = coordinator.request();
        abort.abort();
        expect(await first).toBe(false);
        coordinator.complete(coordinator.getSnapshot());
        expect(await second).toBe(true);
    });
    test("all aborted operations close the dialog", async () => {
        const coordinator = new VerificationCoordinator();
        const abort = new AbortController();
        const pending = coordinator.request(abort.signal);
        abort.abort();
        expect(await pending).toBe(false);
        expect(coordinator.getSnapshot()).toBe(0);
        expect(await coordinator.request(abort.signal)).toBe(false);
    });
    test("subscription cleanup stops notifications", async () => {
        const coordinator = new VerificationCoordinator();
        let calls = 0;
        const unsubscribe = coordinator.subscribe(() => {
            calls += 1;
        });
        const pending = coordinator.request();
        expect(calls).toBe(1);
        unsubscribe();
        coordinator.cancel();
        expect(await pending).toBe(false);
        expect(calls).toBe(1);
    });
});
