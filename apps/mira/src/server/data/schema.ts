import type { MiraSchedule } from "@homelab/contracts/mira";
import { sql } from "drizzle-orm";
import {
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
export const miraConversations = pgTable(
    "mira_conversations",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        version: integer().notNull().default(1),
        providerThread: text("provider_thread"),
        model: text(),
        archivedAt: time("archived_at"),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [index("mira_conversations_owner").on(t.owner, t.id)]
);
export const miraMessages = pgTable(
    "mira_messages",
    {
        id: uuid().primaryKey(),
        conversationId: uuid("conversation_id")
            .notNull()
            .references(() => miraConversations.id),
        role: text().notNull(),
        content: text().notNull().default(""),
        state: text().notNull(),
        attachmentIds: jsonb("attachment_ids").$type<string[]>().notNull().default([]),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_messages_conversation").on(t.conversationId, t.id),
        check("mira_messages_role", sql`${t.role} in ('user','assistant')`),
        check(
            "mira_messages_state",
            sql`${t.state} in ('queued','streaming','completed','interrupted','failed')`
        ),
        check("mira_messages_length", sql`length(${t.content}) <= 256000`),
    ]
);
export const miraTasks = pgTable(
    "mira_tasks",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        description: text().notNull(),
        status: text().notNull(),
        assignee: text().notNull(),
        priority: text().notNull(),
        labels: jsonb().$type<string[]>().notNull().default([]),
        dueAt: time("due_at"),
        completionCriteria: text("completion_criteria").notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        version: integer().notNull().default(1),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_tasks_owner").on(t.owner, t.id),
        check(
            "mira_tasks_state",
            sql`${t.status} in ('todo','in_progress','blocked','done')`
        ),
        check("mira_tasks_assignee", sql`${t.assignee} in ('mira','operator')`),
        check(
            "mira_tasks_priority",
            sql`${t.priority} in ('low','normal','high','urgent')`
        ),
    ]
);
export const miraProgress = pgTable(
    "mira_progress",
    {
        id: uuid().primaryKey(),
        taskId: uuid("task_id")
            .notNull()
            .references(() => miraTasks.id),
        actor: text().notNull(),
        content: text().notNull(),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [index("mira_progress_task").on(t.taskId, t.id)]
);
export const miraAutomations = pgTable(
    "mira_automations",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        prompt: text().notNull(),
        kind: text().notNull(),
        delivery: text().notNull().default("changes"),
        schedule: jsonb().$type<MiraSchedule>().notNull(),
        budgetSeconds: integer("budget_seconds").notNull(),
        version: integer().notNull().default(1),
        nextRunAt: time("next_run_at"),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_automations_due").on(t.nextRunAt),
        check("mira_automations_budget", sql`${t.budgetSeconds} between 30 and 900`),
        check(
            "mira_automations_delivery",
            sql`${t.delivery} in ('reports','changes','silent')`
        ),
    ]
);
export const miraNoticeState = pgTable(
    "mira_notice_state",
    {
        owner: text().notNull(),
        key: text().notNull(),
        fingerprint: text().notNull(),
    },
    (t) => [primaryKey({ columns: [t.owner, t.key] })]
);
export const miraSwitches = pgTable(
    "mira_switches",
    {
        owner: text().notNull(),
        key: text().notNull(),
        enabled: boolean().notNull(),
        reason: text(),
        until: time("until"),
        version: integer().notNull().default(1),
    },
    (t) => [
        primaryKey({ columns: [t.owner, t.key] }),
        check(
            "mira_switches_intent",
            sql`(${t.enabled} and ${t.reason} is null and ${t.until} is null) or (not ${t.enabled} and length(${t.reason}) between 1 and 1000)`
        ),
    ]
);
export const miraRuns = pgTable(
    "mira_runs",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        requestKey: text("request_key").notNull().unique(),
        requestHash: text("request_hash").notNull(),
        conversationId: uuid("conversation_id")
            .notNull()
            .references(() => miraConversations.id),
        userMessageId: uuid("user_message_id")
            .notNull()
            .references(() => miraMessages.id),
        assistantMessageId: uuid("assistant_message_id")
            .notNull()
            .references(() => miraMessages.id),
        taskId: uuid("task_id").references(() => miraTasks.id),
        automationId: uuid("automation_id").references(() => miraAutomations.id),
        state: text().notNull(),
        priority: integer().notNull(),
        lane: text(),
        manual: boolean().notNull().default(false),
        budgetSeconds: integer("budget_seconds").notNull(),
        workerId: uuid("worker_id"),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        cancelRequested: boolean("cancel_requested").notNull().default(false),
        message: text(),
        providerTurn: text("provider_turn"),
        observationHash: text("observation_hash"),
        createdAt: time("created_at").notNull().defaultNow(),
        startedAt: time("started_at"),
        finishedAt: time("finished_at"),
    },
    (t) => [
        index("mira_runs_queue").on(t.state, t.priority, t.id),
        index("mira_runs_owner").on(t.owner, t.id),
        uniqueIndex("mira_runs_one_active_conversation")
            .on(t.conversationId)
            .where(sql`${t.state} in ('queued','running')`),
        check(
            "mira_runs_state",
            sql`${t.state} in ('queued','running','completed','interrupted','failed','needs_attention')`
        ),
    ]
);
export const miraReports = pgTable(
    "mira_reports",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        kind: text().notNull(),
        markdown: text().notNull(),
        runId: uuid("run_id").references(() => miraRuns.id),
        taskId: uuid("task_id").references(() => miraTasks.id),
        version: integer().notNull().default(1),
        archivedAt: time("archived_at"),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [index("mira_reports_owner").on(t.owner, t.id)]
);
export const miraMemory = pgTable(
    "mira_memory",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        content: text().notNull(),
        version: integer().notNull().default(1),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [index("mira_memory_owner").on(t.owner, t.id)]
);
export const miraAttachments = pgTable(
    "mira_attachments",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        name: text().notNull(),
        mediaType: text("media_type").notNull(),
        bytes: integer().notNull(),
        sha256: text().notNull(),
        readyAt: time("ready_at"),
        purgedAt: time("purged_at"),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_attachments_owner").on(t.owner, t.id),
        check("mira_attachments_size", sql`${t.bytes} between 1 and 26214400`),
    ]
);
export const miraToolReceipts = pgTable(
    "mira_tool_receipts",
    {
        id: uuid().primaryKey(),
        runId: uuid("run_id")
            .notNull()
            .references(() => miraRuns.id),
        callId: text("call_id").notNull(),
        tool: text().notNull(),
        inputHash: text("input_hash").notNull(),
        state: text().notNull(),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        finishedAt: time("finished_at"),
    },
    (t) => [uniqueIndex("mira_tool_receipts_call").on(t.runId, t.callId)]
);
export const miraAudit = pgTable(
    "mira_audit",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        actor: text().notNull(),
        action: text().notNull(),
        target: text().notNull(),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [index("mira_audit_owner").on(t.owner, t.id)]
);
export const miraRuntimeStatus = pgTable(
    "mira_runtime_status",
    {
        id: integer().primaryKey().default(1),
        workerId: uuid("worker_id").notNull(),
        version: text().notNull(),
        model: text(),
        ready: boolean().notNull(),
        message: text(),
        heartbeatAt: time("heartbeat_at").notNull(),
    },
    (t) => [check("mira_runtime_status_singleton", sql`${t.id} = 1`)]
);
export const miraEvents = pgTable(
    "mira_events",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        kind: text().notNull(),
        sourceKey: text("source_key").notNull(),
        reference: text().notNull(),
        taskId: uuid("task_id").references(() => miraTasks.id),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [uniqueIndex("mira_events_source").on(t.owner, t.kind, t.sourceKey)]
);
export const miraEventDeliveries = pgTable(
    "mira_event_deliveries",
    {
        eventId: uuid("event_id")
            .notNull()
            .references(() => miraEvents.id),
        automationId: uuid("automation_id")
            .notNull()
            .references(() => miraAutomations.id),
        state: text().notNull().default("pending"),
        runId: uuid("run_id").references(() => miraRuns.id),
        nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    },
    (t) => [
        primaryKey({ columns: [t.eventId, t.automationId] }),
        index("mira_events_pending").on(t.state, t.nextAttemptAt),
        check(
            "mira_events_delivery_state",
            sql`${t.state} in ('pending','dispatched','skipped')`
        ),
    ]
);
