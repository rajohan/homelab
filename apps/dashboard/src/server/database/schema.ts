import type {
    Capability,
    InfrastructureSnapshot,
    JobState,
    ResourceClass,
    ScheduleConfiguration,
} from "@homelab/contracts/operations";
import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    check,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const updatePolicies = pgTable(
    "update_policies",
    {
        target: text().primaryKey(),
        enabled: boolean().notNull().default(false),
        version: integer().notNull().default(1),
        configuration: text().notNull(),
    },
    (table) => [check("update_policies_version", sql`${table.version} >= 1`)]
);
export const operationalIncidents = pgTable(
    "operational_incidents",
    {
        id: uuid().primaryKey(),
        sourceKey: text("source_key").notNull().unique(),
        name: text().notNull(),
        host: text(),
        service: text(),
        severity: text().notNull(),
        state: text().notNull(),
        startedAt: time("started_at").notNull(),
        resolvedAt: time("resolved_at"),
        observedAt: time("observed_at").notNull().defaultNow(),
    },
    (table) => [
        index("operational_incidents_state_id").on(table.state, table.id),
        index("operational_incidents_resolution").on(
            table.state,
            table.resolvedAt.desc(),
            table.id.desc()
        ),
        check(
            "operational_incidents_state",
            sql`${table.state} in ('active','suppressed','resolved')`
        ),
        check(
            "operational_incidents_severity",
            sql`${table.severity} in ('info','warning','error')`
        ),
    ]
);
export const jobRuns = pgTable(
    "job_runs",
    {
        id: uuid().primaryKey(),
        action: text().notNull(),
        label: text().notNull(),
        resourceClass: text("resource_class").$type<ResourceClass>().notNull(),
        state: text().$type<JobState>().notNull(),
        payload: jsonb().$type<Record<string, unknown>>().notNull(),
        fingerprint: text().notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestedBy: text("requested_by").notNull(),
        priority: integer().notNull().default(0),
        attempt: integer().notNull().default(0),
        attemptLimit: integer("attempt_limit").notNull(),
        retrySafe: boolean("retry_safe").notNull(),
        timeoutMs: integer("timeout_ms").notNull(),
        resourceKeys: text("resource_keys").array().notNull(),
        createdAt: time("created_at").notNull().defaultNow(),
        availableAt: time("available_at").notNull().defaultNow(),
        startedAt: time("started_at"),
        finishedAt: time("finished_at"),
        workerId: uuid("worker_id"),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        cancelRequested: boolean("cancel_requested").notNull().default(false),
        message: text(),
    },
    (table) => [
        uniqueIndex("job_runs_idempotency").on(table.idempotencyKey),
        index("job_runs_queue").on(table.state, table.availableAt, table.priority),
        index("job_runs_action_history").on(table.action, table.id),
        check(
            "job_runs_state",
            sql`${table.state} in ('queued','running','succeeded','failed','timed_out','cancelled')`
        ),
        check(
            "job_runs_attempts",
            sql`${table.attempt} >= 0 and ${table.attemptLimit} between 1 and 10 and (${table.timeoutMs} between 1000 and 3600000 or (${table.timeoutMs} between 3600001 and 604800000 and ${table.attemptLimit} = 1 and not ${table.retrySafe}))`
        ),
    ]
);
export const jobSchedules = pgTable(
    "job_schedules",
    {
        id: uuid().primaryKey(),
        action: text().notNull().unique(),
        enabled: boolean().notNull().default(true),
        schedule: jsonb().$type<ScheduleConfiguration>().notNull(),
        disableReason: text("disable_reason"),
        disabledUntil: time("disabled_until"),
        version: integer().notNull().default(1),
        nextRunAt: time("next_run_at").notNull(),
    },
    (table) => [
        check(
            "job_schedules_disable_intent",
            sql`(${table.enabled} and ${table.disableReason} is null and ${table.disabledUntil} is null) or (not ${table.enabled} and ${table.disableReason} is not null and length(${table.disableReason}) between 1 and 1000)`
        ),
    ]
);
export const workerControl = pgTable(
    "worker_control",
    {
        id: integer().primaryKey().default(1),
        paused: boolean().notNull().default(false),
        version: integer().notNull().default(1),
        updatedAt: time("updated_at"),
        updatedBy: text("updated_by"),
    },
    (table) => [check("worker_control_singleton", sql`${table.id} = 1`)]
);
export const resourceLeases = pgTable("resource_leases", {
    key: text().primaryKey(),
    runId: uuid("run_id")
        .notNull()
        .references(() => jobRuns.id, { onDelete: "cascade" }),
    leaseToken: uuid("lease_token").notNull(),
});
export const workers = pgTable("workers", {
    id: uuid().primaryKey(),
    version: text().notNull(),
    heartbeatAt: time("heartbeat_at").notNull(),
    capacity: integer().notNull(),
    draining: boolean().notNull().default(false),
    startedAt: time("started_at").notNull().defaultNow(),
});
export const automationAccounts = pgTable("automation_accounts", {
    id: uuid().primaryKey(),
    label: text().notNull(),
    capabilities: jsonb().$type<Capability[]>().notNull(),
    version: integer().notNull().default(1),
    disabledAt: time("disabled_at"),
    createdAt: time("created_at").notNull().defaultNow(),
});
export const automationCredentials = pgTable("automation_credentials", {
    id: uuid().primaryKey(),
    accountId: uuid("account_id")
        .notNull()
        .references(() => automationAccounts.id, { onDelete: "cascade" }),
    prefix: text().notNull().unique(),
    digest: text().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    expiresAt: time("expires_at"),
    revokedAt: time("revoked_at"),
    lastUsedAt: time("last_used_at"),
});
export const auditEvents = pgTable(
    "operation_audit",
    {
        id: uuid().primaryKey(),
        actor: text().notNull(),
        action: text().notNull(),
        target: text().notNull(),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (table) => [
        index("operation_audit_target").on(table.target, table.id),
        check(
            "operation_audit_message_length",
            sql`${table.message} is null or length(${table.message}) between 1 and 500`
        ),
    ]
);
export const snapshots = pgTable("operation_snapshots", {
    key: text().primaryKey(),
    value: jsonb().$type<InfrastructureSnapshot>().notNull(),
    capturedAt: time("captured_at").notNull(),
    mutatedAt: time("mutated_at")
        .notNull()
        .default(sql`clock_timestamp()`),
    mutationXid: text("mutation_xid")
        .notNull()
        .default(sql`pg_current_xact_id()::text`),
});
export const rateWindows = pgTable("operation_rate_windows", {
    key: text().primaryKey(),
    count: integer().notNull(),
    expiresAt: time("expires_at").notNull(),
});

export const notifications = pgTable(
    "dashboard_notifications",
    {
        id: uuid().primaryKey(),
        publicationOrder: bigint("publication_order", {
            mode: "bigint",
        }).generatedAlwaysAsIdentity(),
        source: text().notNull(),
        sourceKey: text("source_key").notNull(),
        title: text().notNull(),
        message: text().notNull(),
        severity: text().notNull(),
        destination: text(),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("dashboard_notifications_publication_order").on(
            table.publicationOrder
        ),
        uniqueIndex("dashboard_notifications_source_key").on(
            table.source,
            table.sourceKey
        ),
        index("dashboard_notifications_severity_id").on(table.severity, table.id),
        check(
            "dashboard_notifications_severity",
            sql`${table.severity} in ('info','success','warning','error')`
        ),
        check(
            "dashboard_notifications_destination",
            sql`${table.destination} is null or ${table.destination} in ('jobs','applications','infrastructure','alerts')`
        ),
    ]
);

export const notificationReceipts = pgTable(
    "notification_receipts",
    {
        notificationId: uuid("notification_id")
            .notNull()
            .references(() => notifications.id, { onDelete: "cascade" }),
        actor: text().notNull(),
        readAt: time("read_at"),
        dismissedAt: time("dismissed_at"),
    },
    (table) => [
        primaryKey({ columns: [table.notificationId, table.actor] }),
        index("notification_receipts_actor").on(table.actor, table.notificationId),
    ]
);
