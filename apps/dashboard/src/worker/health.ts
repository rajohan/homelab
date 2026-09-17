export interface WorkerState {
    heartbeatAt: number;
    draining: boolean;
    paused: boolean;
    schedules: { action: string; enabled: boolean; overdue: boolean }[];
    active: number;
    completed: Record<"succeeded" | "failed" | "interrupted" | "timed_out", number>;
}

/**
 * Allocate process-local health counters; durable job state remains in PostgreSQL.
 * @returns A fresh state object shared by the worker and its private health endpoint.
 */
export function createWorkerState(): WorkerState {
    return {
        heartbeatAt: 0,
        draining: false,
        paused: false,
        schedules: [],
        active: 0,
        completed: { succeeded: 0, failed: 0, interrupted: 0, timed_out: 0 },
    };
}

/**
 * Serve private liveness, readiness and low-cardinality Prometheus metrics.
 * @param state - Current coordination heartbeat and process-local counters.
 * @param binding - Private listener address; never expose this unauthenticated port publicly.
 * @returns The HTTP listener, owned by the worker process lifecycle.
 */
export function startWorkerHealth(
    state: WorkerState,
    binding: { hostname: string; port: number }
) {
    return Bun.serve({
        ...binding,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (request.method !== "GET") return new Response(null, { status: 405 });
            const ready = !state.draining && state.heartbeatAt > Date.now() - 30_000;
            if (path === "/health/live" || path === "/health/ready")
                return Response.json(
                    {
                        service: "dashboard-worker",
                        status: path === "/health/live" || ready ? "ok" : "unavailable",
                        paused: state.paused,
                    },
                    {
                        status: path === "/health/live" || ready ? 200 : 503,
                        headers: { "Cache-Control": "no-store" },
                    }
                );
            if (path !== "/metrics") return new Response(null, { status: 404 });
            return new Response(
                [
                    "# HELP homelab_worker_ready Whether queue coordination is healthy, including an intentional pause.",
                    "# TYPE homelab_worker_ready gauge",
                    `homelab_worker_ready ${Number(ready)}`,
                    "# HELP homelab_worker_paused Whether new claims and scheduled submissions are intentionally paused.",
                    "# TYPE homelab_worker_paused gauge",
                    `homelab_worker_paused ${Number(state.paused)}`,
                    "# HELP homelab_schedule_enabled Whether the registered schedule is enabled.",
                    "# TYPE homelab_schedule_enabled gauge",
                    ...state.schedules.map(
                        (schedule) =>
                            `homelab_schedule_enabled{action="${schedule.action}"} ${Number(schedule.enabled)}`
                    ),
                    "# HELP homelab_schedule_overdue Whether an enabled, idle schedule is overdue while workers are unpaused.",
                    "# TYPE homelab_schedule_overdue gauge",
                    ...state.schedules.map(
                        (schedule) =>
                            `homelab_schedule_overdue{action="${schedule.action}"} ${Number(schedule.overdue)}`
                    ),
                    "# HELP homelab_worker_active_jobs Currently executing handlers in this process.",
                    "# TYPE homelab_worker_active_jobs gauge",
                    `homelab_worker_active_jobs ${state.active}`,
                    "# HELP homelab_worker_jobs_total Handler outcomes since this process started, not queue totals.",
                    "# TYPE homelab_worker_jobs_total counter",
                    ...Object.entries(state.completed).map(
                        ([outcome, count]) =>
                            `homelab_worker_jobs_total{outcome="${outcome}"} ${count}`
                    ),
                    "",
                ].join("\n"),
                {
                    headers: {
                        "Content-Type": "text/plain; version=0.0.4",
                        "Cache-Control": "no-store",
                    },
                }
            );
        },
    });
}
