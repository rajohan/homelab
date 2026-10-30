import {
    miraDefaultChatSettings,
    type MiraActivity,
    type MiraChatSettings,
    type MiraModel,
    type MiraSchedule,
} from "@homelab/contracts/mira";
import type { MiraCodeContent, MiraCodePublication } from "@homelab/contracts/miraCode";
import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import type { MiraMailContent } from "@homelab/contracts/miraMail";
import type { MiraPublicationContent } from "@homelab/contracts/miraPublication";
import type { MiraSocialContent } from "@homelab/contracts/miraSocial";
import { sql } from "drizzle-orm";
import {
    type AnyPgColumn,
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

import type { DaytonaBinding } from "../integrations/daytona/configuration";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const miraConversations = pgTable(
    "mira_conversations",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        title: text().notNull(),
        version: integer().notNull().default(1),
        providerThread: text("provider_thread"),
        providerPolicyHash: text("provider_policy_hash"),
        providerPurgeRetryAt: time("provider_purge_retry_at"),
        providerContextReady: boolean("provider_context_ready").notNull().default(false),
        model: text(),
        settings: jsonb()
            .$type<MiraChatSettings>()
            .notNull()
            .default(miraDefaultChatSettings),
        archivedAt: time("archived_at"),
        deletedAt: time("deleted_at"),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_conversations_owner").on(t.owner, t.id),
        index("mira_conversations_activity")
            .on(t.owner, t.updatedAt, t.id)
            .where(sql`${t.deletedAt} is null`),
    ]
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
        index("mira_tasks_conversation")
            .on(t.owner, t.conversationId, t.id)
            .where(sql`${t.deletedAt} is null`),
        index("mira_tasks_due")
            .on(t.dueAt, t.id)
            .where(
                sql`${t.deletedAt} is null and ${t.status} <> 'done' and ${t.dueAt} is not null`
            ),
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
        skillResumeAt: time("skill_resume_at"),
        version: integer().notNull().default(1),
        changedAt: time("changed_at").notNull().defaultNow(),
        bindingHash: text("binding_hash"),
        bindingActivatedAt: time("binding_activated_at"),
    },
    (t) => [
        primaryKey({ columns: [t.owner, t.key] }),
        check(
            "mira_switches_skill_resume",
            sql`(${t.key} like 'skill:%' and ${t.until} is null and (not ${t.enabled} or ${t.skillResumeAt} is null)) or (${t.key} not like 'skill:%' and ${t.skillResumeAt} is null)`
        ),
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
        reviewedRunId: uuid("reviewed_run_id").references((): AnyPgColumn => miraRuns.id),
        activity: jsonb().$type<MiraActivity>(),
        effectiveSettings: jsonb("effective_settings").$type<MiraChatSettings>(),
        settings: jsonb()
            .$type<MiraChatSettings>()
            .notNull()
            .default(miraDefaultChatSettings),
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
        automationKind: text("automation_kind"),
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
        index("mira_runs_conversation").on(t.conversationId, t.manual),
        index("mira_runs_owner").on(t.owner, t.id),
        index("mira_runs_conversation_history").on(t.conversationId, t.id),
        index("mira_runs_conversation_task")
            .on(t.owner, t.conversationId, t.taskId)
            .where(sql`${t.taskId} is not null`),
        index("mira_runs_task").on(t.owner, t.taskId, t.id),
        uniqueIndex("mira_runs_one_active_task")
            .on(t.taskId)
            .where(sql`${t.taskId} is not null and ${t.state} in ('queued','running')`),
        index("mira_runs_reviewed_run").on(t.reviewedRunId),
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
        purgeRetryAt: time("purge_retry_at"),
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
        proposal: jsonb().$type<Record<string, unknown>>(),
        state: text().notNull(),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        finishedAt: time("finished_at"),
    },
    (t) => [
        uniqueIndex("mira_tool_receipts_call").on(t.runId, t.callId),
        index("mira_tool_receipts_proposals")
            .on(t.state, t.createdAt)
            .where(sql`${t.proposal} is not null`),
    ]
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
        skillCatalogHash: text("skill_catalog_hash"),
        skillCatalogWorkerId: uuid("skill_catalog_worker_id"),
        model: text(),
        ready: boolean().notNull(),
        message: text(),
        heartbeatAt: time("heartbeat_at").notNull(),
        models: jsonb().$type<MiraModel[]>().notNull().default([]),
        integrations: jsonb()
            .$type<{ owner: string; key: string }[]>()
            .notNull()
            .default([]),
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
        receivedAt: time("received_at").notNull().defaultNow(),
        createdAt: time("created_at").notNull().defaultNow(),
        eligibilityAt: time("eligibility_at"),
    },
    (t) => [
        uniqueIndex("mira_events_source").on(t.owner, t.kind, t.sourceKey),
        index("mira_events_received_owner").on(t.owner, t.kind, t.receivedAt),
        index("mira_events_received_cleanup").on(t.kind, t.receivedAt),
    ]
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
        index("mira_events_run").on(t.runId),
        check(
            "mira_events_delivery_state",
            sql`${t.state} in ('pending','dispatched','skipped')`
        ),
    ]
);

export const miraIntegrationState = pgTable(
    "mira_integration_state",
    {
        owner: text().notNull(),
        key: text().notNull(),
        binding: text().notNull(),
        controlVersion: integer("control_version").notNull(),
        startedAt: time("started_at").notNull(),
        completedThrough: time("completed_through").notNull(),
        windowEnd: time("window_end"),
        cursor: text(),
        eventAnchor: text("event_anchor"),
        windowHead: text("window_head"),
        pendingScans: jsonb("pending_scans")
            .notNull()
            .default(sql`'[]'::jsonb`),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        nextAttemptAt: time("next_attempt_at").notNull(),
        lastSuccessAt: time("last_success_at"),
        message: text(),
        heartbeatAt: time("heartbeat_at").notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.owner, t.key] })]
);

export const miraControlWindows = pgTable(
    "mira_control_windows",
    {
        owner: text().notNull(),
        key: text().notNull(),
        version: integer().notNull(),
        startedAt: time("started_at").notNull(),
        endedAt: time("ended_at"),
    },
    (t) => [
        primaryKey({ columns: [t.owner, t.key, t.version] }),
        index("mira_control_windows_eligibility").on(t.owner, t.key, t.startedAt),
    ]
);

export const miraIntegrationReceivers = pgTable("mira_integration_receivers", {
    key: text().primaryKey(),
    bindingHash: text("binding_hash"),
    heartbeatAt: time("heartbeat_at").notNull().defaultNow(),
});

export const miraMailDrafts = pgTable(
    "mira_mail_drafts",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        inboxId: text("inbox_id").notNull(),
        bindingHash: text("binding_hash").notNull(),
        version: integer().notNull().default(1),
        state: text().notNull().default("draft"),
        content: jsonb().$type<MiraMailContent>().notNull(),
        contentHash: text("content_hash").notNull(),
        approvedVersion: integer("approved_version"),
        approvedBy: text("approved_by"),
        approvedAt: time("approved_at"),
        controlVersion: integer("control_version"),
        attemptToken: uuid("attempt_token"),
        retryAfter: time("retry_after"),
        startedAt: time("started_at"),
        providerMessageId: text("provider_message_id"),
        providerThreadId: text("provider_thread_id"),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_mail_drafts_owner").on(t.owner, t.createdAt, t.id),
        index("mira_mail_drafts_dispatch").on(t.state, t.id),
        check(
            "mira_mail_drafts_state",
            sql`${t.state} IN ('draft','queued','sending','sent','needs_attention','cancelled')`
        ),
        check("mira_mail_drafts_version", sql`${t.version} >= 1`),
        check(
            "mira_mail_drafts_approval",
            sql`${t.state} NOT IN ('queued','sending','sent','needs_attention') OR (${t.approvedVersion} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.controlVersion} IS NOT NULL)`
        ),
    ]
);

// One account-wide watermark bounds durable quota suppression independently of traffic.
export const miraMailIntake = pgTable("mira_mail_intake", {
    owner: text().primaryKey(),
    skippedThrough: time("skipped_through").notNull(),
});

export const miraTaskRunReviews = pgTable("mira_task_run_reviews", {
    runId: uuid("run_id")
        .primaryKey()
        .references(() => miraRuns.id),
    taskId: uuid("task_id")
        .notNull()
        .references(() => miraTasks.id),
    owner: text().notNull(),
    actor: text().notNull(),
    reviewedAt: time("reviewed_at").notNull().defaultNow(),
});

export const miraPublications = pgTable(
    "mira_publications",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        accountId: text("account_id").notNull(),
        bindingHash: text("binding_hash").notNull(),
        version: integer().notNull().default(1),
        state: text().notNull().default("draft"),
        content: jsonb().$type<MiraPublicationContent>().notNull(),
        contentHash: text("content_hash").notNull(),
        approvedVersion: integer("approved_version"),
        approvedBy: text("approved_by"),
        approvedAt: time("approved_at"),
        controlVersion: integer("control_version"),
        attemptToken: uuid("attempt_token"),
        retryAfter: time("retry_after"),
        startedAt: time("started_at"),
        phase: text(),
        slug: text(),
        providerVersionId: text("provider_version_id"),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_publications_owner").on(t.owner, t.createdAt, t.id),
        index("mira_publications_dispatch").on(t.state, t.id),
        uniqueIndex("mira_publications_active_owner")
            .on(t.owner)
            .where(sql`${t.state} = 'publishing'`),
        check(
            "mira_publications_state",
            sql`${t.state} IN ('draft','queued','publishing','published','needs_attention','cancelled')`
        ),
        check("mira_publications_version", sql`${t.version} >= 1`),
        check(
            "mira_publications_approval",
            sql`${t.state} NOT IN ('queued','publishing','published','needs_attention') OR (${t.approvedVersion} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.controlVersion} IS NOT NULL)`
        ),
    ]
);

export const miraSocialDrafts = pgTable(
    "mira_social_drafts",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        agentName: text("agent_name").notNull(),
        bindingHash: text("binding_hash").notNull(),
        version: integer().notNull().default(1),
        state: text().notNull().default("draft"),
        content: jsonb().$type<MiraSocialContent>().notNull(),
        contentHash: text("content_hash").notNull(),
        approvedVersion: integer("approved_version"),
        approvedBy: text("approved_by"),
        approvedAt: time("approved_at"),
        controlStamp: text("control_stamp"),
        attemptToken: uuid("attempt_token"),
        retryAfter: time("retry_after"),
        startedAt: time("started_at"),
        providerId: text("provider_id"),
        verificationCode: text("verification_code"),
        challenge: text(),
        expiresAt: time("expires_at"),
        answer: text(),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_social_drafts_owner").on(t.owner, t.createdAt, t.id),
        index("mira_social_drafts_dispatch").on(t.state, t.id),
        uniqueIndex("mira_social_drafts_active_owner")
            .on(t.owner)
            .where(sql`${t.state} IN ('publishing','verifying')`),
        check("mira_social_drafts_version", sql`${t.version} >= 1`),
        check(
            "mira_social_drafts_state",
            sql`${t.state} IN ('draft','queued','publishing','verification_required','queued_verification','verifying','submitted','needs_attention','cancelled')`
        ),
        check(
            "mira_social_drafts_approval",
            sql`${t.state} IN ('draft','cancelled') OR (${t.approvedVersion} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.controlStamp} IS NOT NULL)`
        ),
        check(
            "mira_social_drafts_verification",
            sql`${t.state} NOT IN ('verification_required','queued_verification','verifying') OR (${t.providerId} IS NOT NULL AND ${t.verificationCode} IS NOT NULL AND ${t.challenge} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`
        ),
    ]
);

export const miraSocialCooldowns = pgTable("mira_social_cooldowns", {
    owner: text().primaryKey(),
    until: time("until").notNull(),
});

export const miraDaytonaJobs = pgTable(
    "mira_daytona_jobs",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        taskId: uuid("task_id").references(() => miraTasks.id),
        binding: jsonb().$type<DaytonaBinding>().notNull(),
        bindingHash: text("binding_hash").notNull(),
        version: integer().notNull().default(1),
        content: jsonb().$type<MiraDaytonaContent>().notNull(),
        contentHash: text("content_hash").notNull(),
        state: text().notNull().default("draft"),
        phase: text().notNull().default("idle"),
        cleanup: text().notNull().default("not_needed"),
        outcome: text(),
        cancelRequested: boolean("cancel_requested").notNull().default(false),
        approvedAt: time("approved_at"),
        controlVersion: integer("control_version"),
        startedAt: time("started_at"),
        deadline: time("deadline"),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        retryAt: time("retry_at"),
        sandboxId: uuid("sandbox_id"),
        commandId: text("command_id"),
        uploadIndex: integer("upload_index").notNull().default(0),
        deleteAttempted: boolean("delete_attempted").notNull().default(false),
        cleanupResolution: jsonb("cleanup_resolution").$type<{
            actor: string;
            reason: string;
            at: string;
        }>(),
        exitCode: integer("exit_code"),
        stdout: text().notNull().default(""),
        stderr: text().notNull().default(""),
        output: text().notNull().default(""),
        files: jsonb().$type<{ name: string; id: string }[]>().notNull().default([]),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_daytona_owner").on(t.owner, t.createdAt, t.id),
        index("mira_daytona_dispatch").on(t.cleanup, t.state, t.retryAt),
        index("mira_daytona_admission").on(t.startedAt),
        uniqueIndex("mira_daytona_single_active")
            .on(sql`(true)`)
            .where(sql`${t.cleanup}='pending'`),
        check(
            "mira_daytona_state",
            sql`${t.state} IN ('draft','queued','running','completed','failed','cancelled','needs_attention')`
        ),
        check(
            "mira_daytona_cleanup",
            sql`${t.cleanup} IN ('not_needed','pending','confirmed','operator_confirmed')`
        ),
        check(
            "mira_daytona_outcome",
            sql`${t.outcome} IS NULL OR ${t.outcome} IN ('completed','failed','cancelled','needs_attention')`
        ),
        check(
            "mira_daytona_resolution",
            sql`(${t.cleanup}='operator_confirmed')=(${t.cleanupResolution} IS NOT NULL) AND (${t.cleanup}<>'operator_confirmed' OR (${t.phase}='closed' AND ${t.state} IN ('cancelled','needs_attention')))`
        ),
        check("mira_daytona_version", sql`${t.version}>0`),
        check("mira_daytona_upload", sql`${t.uploadIndex} BETWEEN 0 AND 4`),
        check(
            "mira_daytona_logs",
            sql`octet_length(${t.stdout})+octet_length(${t.stderr})+octet_length(${t.output})<=131072`
        ),
    ]
);

export const miraCodePublications = pgTable(
    "mira_code_publications",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        conversationId: uuid("conversation_id").references(() => miraConversations.id),
        checkId: uuid("check_id")
            .notNull()
            .references(() => miraDaytonaJobs.id),
        bindingHash: text("binding_hash").notNull(),
        version: integer().notNull().default(1),
        state: text().notNull().default("draft"),
        content: jsonb().$type<MiraCodeContent>().notNull(),
        contentHash: text("content_hash").notNull(),
        approvedVersion: integer("approved_version"),
        approvedBy: text("approved_by"),
        approvedAt: time("approved_at"),
        controlVersion: integer("control_version"),
        attemptToken: uuid("attempt_token"),
        startedAt: time("started_at"),
        authoredAt: text("authored_at"),
        phase: text(),
        branch: text(),
        tree: text(),
        commit: text(),
        number: integer(),
        observation: jsonb().$type<MiraCodePublication["observation"]>(),
        inspectionRequested: boolean("inspection_requested").notNull().default(false),
        inspectionToken: uuid("inspection_token"),
        inspectionStartedAt: time("inspection_started_at"),
        observedAt: time("observed_at"),
        message: text(),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_code_owner").on(t.owner, t.createdAt, t.id),
        index("mira_code_queue").on(t.state, t.id),
        uniqueIndex("mira_code_one_active")
            .on(sql`(true)`)
            .where(sql`${t.state}='publishing'`),
        uniqueIndex("mira_code_check_once")
            .on(t.checkId)
            .where(sql`${t.state} NOT IN ('draft','cancelled')`),
        check(
            "mira_code_state",
            sql`${t.state} IN ('draft','queued','publishing','published','needs_attention','cancelled')`
        ),
        check("mira_code_version", sql`${t.version} >= 1`),
        check(
            "mira_code_approval",
            sql`${t.state} NOT IN ('queued','publishing','published','needs_attention') OR (${t.approvedVersion} IS NOT NULL AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.controlVersion} IS NOT NULL)`
        ),
    ]
);

export const miraImprovementGrants = pgTable("mira_improvement_grants", {
    automationId: uuid("automation_id")
        .primaryKey()
        .references(() => miraAutomations.id),
    owner: text().notNull(),
    enabled: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    automationVersion: integer("automation_version").notNull(),
    bindingHash: text("binding_hash"),
    approvedBy: text("approved_by").notNull(),
    updatedAt: time("updated_at").notNull().defaultNow(),
});
export const miraImprovements = pgTable(
    "mira_improvements",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        runId: uuid("run_id")
            .notNull()
            .unique()
            .references(() => miraRuns.id),
        conversationId: uuid("conversation_id")
            .notNull()
            .references(() => miraConversations.id),
        automationId: uuid("automation_id")
            .notNull()
            .references(() => miraAutomations.id),
        grantVersion: integer("grant_version").notNull(),
        bindingHash: text("binding_hash").notNull(),
        automationControl: integer("automation_control").notNull(),
        autonomyControl: integer("autonomy_control").notNull(),
        policyVersion: integer("policy_version").notNull(),
        daytonaControl: integer("daytona_control").notNull(),
        githubControl: integer("github_control").notNull(),
        state: text().notNull().default("queued"),
        content: jsonb().notNull(),
        contentHash: text("content_hash").notNull(),
        cloudHash: text("cloud_hash"),
        publicationHash: text("publication_hash"),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        message: text(),
        reportId: uuid("report_id"),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_improvements_queue").on(t.state, t.id),
        index("mira_improvements_owner").on(t.owner, t.id),
        uniqueIndex("mira_improvements_one_active")
            .on(sql`(true)`)
            .where(sql`${t.state} IN ('queued','checking','publishing')`),
        check(
            "mira_improvements_state",
            sql`${t.state} IN ('queued','checking','publishing','published','failed','cancelled','needs_attention')`
        ),
    ]
);

export const miraComputers = pgTable(
    "mira_computers",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        label: text().notNull(),
        version: integer().notNull().default(1),
        state: text().notNull(),
        pairDigest: text("pair_digest"),
        credentialDigest: text("credential_digest"),
        installationId: uuid("installation_id"),
        platform: text(),
        companionVersion: text("companion_version"),
        pairedAt: time("paired_at"),
        expiresAt: time("expires_at").notNull(),
        connectionId: uuid("connection_id"),
        connectionExpiresAt: time("connection_expires_at"),
        sequence: integer().notNull().default(0),
        lastSeenAt: time("last_seen_at"),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_computers_owner").on(t.owner, t.createdAt, t.id),
        check("mira_computers_version", sql`${t.version} > 0 AND ${t.sequence} >= 0`),
        check("mira_computers_label", sql`length(${t.label}) BETWEEN 1 AND 80`),
        check(
            "mira_computers_platform",
            sql`${t.platform} IS NULL OR ${t.platform} IN ('win32','linux','darwin')`
        ),
        check(
            "mira_computers_credential_state",
            sql`
        (${t.state}='pending' AND ${t.pairDigest} IS NOT NULL AND ${t.credentialDigest} IS NULL AND ${t.pairedAt} IS NULL) OR
        (${t.state}='paired' AND ${t.pairDigest} IS NULL AND ${t.credentialDigest} IS NOT NULL AND ${t.pairedAt} IS NOT NULL AND ${t.installationId} IS NOT NULL AND ${t.platform} IS NOT NULL) OR
        (${t.state}='revoked' AND ${t.pairDigest} IS NULL AND ${t.credentialDigest} IS NULL)`
        ),
        check(
            "mira_computers_connection",
            sql`(${t.connectionId} IS NULL AND ${t.connectionExpiresAt} IS NULL) OR (${t.state}='paired' AND ${t.connectionId} IS NOT NULL AND ${t.connectionExpiresAt} IS NOT NULL)`
        ),
    ]
);

export const miraComputerAccess = pgTable(
    "mira_computer_access",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        computerId: uuid("computer_id")
            .notNull()
            .references(() => miraComputers.id),
        computerVersion: integer("computer_version").notNull(),
        connectionId: uuid("connection_id").notNull(),
        runId: uuid("run_id")
            .notNull()
            .references(() => miraRuns.id),
        runLease: uuid("run_lease").notNull(),
        controls: jsonb().notNull(),
        mode: text().notNull(),
        state: text().notNull().default("pending"),
        targetId: uuid("target_id"),
        expiresAt: time("expires_at").notNull(),
        acceptedAt: time("accepted_at"),
        stoppedAt: time("stopped_at"),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_computer_access_owner").on(t.owner, t.createdAt, t.id),
        uniqueIndex("mira_computer_access_computer")
            .on(t.computerId)
            .where(sql`${t.state} IN ('pending','active')`),
        uniqueIndex("mira_computer_access_run")
            .on(t.runId)
            .where(sql`${t.state} IN ('pending','active')`),
        check("mira_computer_access_mode", sql`${t.mode} IN ('view','control')`),
        check(
            "mira_computer_access_state",
            sql`(${t.state}='pending' AND ${t.targetId} IS NULL AND ${t.acceptedAt} IS NULL AND ${t.stoppedAt} IS NULL) OR (${t.state}='active' AND ${t.targetId} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL AND ${t.stoppedAt} IS NULL) OR (${t.state}='stopped' AND ${t.stoppedAt} IS NOT NULL)`
        ),
        check(
            "mira_computer_access_duration",
            sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt}+interval '5 minutes'`
        ),
    ]
);

export const miraComputerCommands = pgTable(
    "mira_computer_commands",
    {
        id: uuid()
            .primaryKey()
            .references(() => miraToolReceipts.id),
        owner: text().notNull(),
        accessId: uuid("access_id")
            .notNull()
            .references(() => miraComputerAccess.id),
        runId: uuid("run_id")
            .notNull()
            .references(() => miraRuns.id),
        runLease: uuid("run_lease").notNull(),
        connectionId: uuid("connection_id").notNull(),
        targetId: uuid("target_id").notNull(),
        action: text().notNull(),
        state: text().notNull().default("queued"),
        payload: jsonb(),
        result: jsonb(),
        createdAt: time("created_at").notNull().defaultNow(),
        expiresAt: time("expires_at").notNull(),
        claimedAt: time("claimed_at"),
        finishedAt: time("finished_at"),
    },
    (t) => [
        index("mira_computer_commands_owner").on(t.owner, t.state),
        index("mira_computer_commands_access").on(t.accessId),
        index("mira_computer_commands_cleanup").on(t.state, t.expiresAt),
        uniqueIndex("mira_computer_commands_active")
            .on(t.accessId)
            .where(sql`${t.state} IN ('queued','claimed','completed')`),
        check(
            "mira_computer_commands_action",
            sql`${t.action} IN ('observe','click','click_element','type')`
        ),
        check(
            "mira_computer_commands_state",
            sql`${t.state} IN ('queued','claimed','completed','consumed','refused','unknown')`
        ),
        check(
            "mira_computer_commands_duration",
            sql`${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '15 seconds'`
        ),
        check(
            "mira_computer_commands_payload",
            sql`(${t.state}='queued' AND ${t.payload} IS NOT NULL AND ${t.result} IS NULL) OR (${t.state}='claimed' AND ${t.payload} IS NULL AND ${t.result} IS NULL) OR (${t.state}='completed' AND ${t.payload} IS NULL AND ${t.result} IS NOT NULL) OR (${t.state} IN ('consumed','refused','unknown') AND ${t.payload} IS NULL AND ${t.result} IS NULL)`
        ),
        check(
            "mira_computer_commands_size",
            sql`(${t.payload} IS NULL OR octet_length(${t.payload}::text)<=32768) AND (${t.result} IS NULL OR octet_length(${t.result}::text)<=3145728)`
        ),
    ]
);

export const miraBrowserAccess = pgTable(
    "mira_browser_access",
    {
        id: uuid().primaryKey(),
        owner: text().notNull(),
        runId: uuid("run_id")
            .notNull()
            .references(() => miraRuns.id),
        runLease: uuid("run_lease").notNull(),
        controls: jsonb().notNull(),
        mode: text().notNull(),
        policy: jsonb(),
        state: text().notNull().default("pending"),
        hostToken: uuid("host_token"),
        claimedAt: time("claimed_at"),
        closedAt: time("closed_at"),
        expiresAt: time("expires_at").notNull(),
        createdAt: time("created_at").notNull().defaultNow(),
    },
    (t) => [
        index("mira_browser_access_history").on(t.owner, t.createdAt, t.id),
        uniqueIndex("mira_browser_access_owner")
            .on(t.owner)
            .where(sql`${t.state}<>'closed'`),
        check("mira_browser_access_mode", sql`${t.mode} IN ('view','control')`),
        check(
            "mira_browser_access_state",
            sql`(${t.state}='pending' AND ${t.hostToken} IS NULL AND ${t.claimedAt} IS NULL AND ${t.closedAt} IS NULL AND ${t.policy} IS NOT NULL) OR (${t.state}='active' AND ${t.hostToken} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.closedAt} IS NULL AND ${t.policy} IS NOT NULL) OR (${t.state}='stopping' AND ${t.hostToken} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.closedAt} IS NULL AND ${t.policy} IS NULL) OR (${t.state}='closed' AND ${t.closedAt} IS NOT NULL AND ${t.policy} IS NULL)`
        ),
        check(
            "mira_browser_access_duration",
            sql`${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '5 minutes'`
        ),
        check(
            "mira_browser_access_policy_size",
            sql`${t.policy} IS NULL OR octet_length(${t.policy}::text)<=131072`
        ),
    ]
);

export const miraBrowserProcesses = pgTable(
    "mira_browser_processes",
    {
        id: uuid().primaryKey(),
        accessId: uuid("access_id")
            .notNull()
            .references(() => miraBrowserAccess.id),
        hostId: uuid("host_id").notNull(),
        imageId: text("image_id").notNull(),
        networkId: text("network_id"),
        leaseToken: uuid("lease_token").notNull(),
        leaseExpiresAt: time("lease_expires_at").notNull(),
        phase: text().notNull().default("reserved"),
        state: text().notNull().default("active"),
        containerId: text("container_id"),
        cleanupEvidence: text("cleanup_evidence"),
        createdAt: time("created_at").notNull().defaultNow(),
        removedAt: time("removed_at"),
    },
    (t) => [
        uniqueIndex("mira_browser_process_access").on(t.accessId),
        uniqueIndex("mira_browser_process_network")
            .on(t.hostId, t.networkId)
            .where(sql`${t.state} <> 'removed'`),
        check(
            "mira_browser_process_network_id",
            sql`${t.networkId} IS NULL OR ${t.networkId} ~ '^[a-f0-9]{64}$'`
        ),
        uniqueIndex("mira_browser_process_container").on(t.hostId, t.containerId),
        index("mira_browser_process_recovery").on(t.hostId, t.state, t.leaseExpiresAt),
        check("mira_browser_process_image", sql`${t.imageId} ~ '^sha256:[a-f0-9]{64}$'`),
        check(
            "mira_browser_process_phase",
            sql`(${t.phase} IN ('reserved','creating','rejected') AND ${t.containerId} IS NULL AND (${t.phase}<>'rejected' OR ${t.state}<>'active')) OR (${t.phase}='created' AND ${t.containerId} IS NOT NULL AND ${t.containerId} ~ '^[a-f0-9]{64}$')`
        ),
        check(
            "mira_browser_process_state",
            sql`(${t.state} IN ('active','cleanup') AND ${t.removedAt} IS NULL AND ${t.cleanupEvidence} IS NULL) OR (${t.state}='removed' AND ${t.removedAt} IS NOT NULL AND ${t.cleanupEvidence} IS NOT NULL AND ((${t.phase}='reserved' AND ${t.cleanupEvidence}='not-created') OR (${t.phase}='rejected' AND ${t.cleanupEvidence}='rejected') OR (${t.phase}='created' AND ${t.cleanupEvidence} IN ('removed','absent'))))`
        ),
    ]
);

export const miraBrowserCommands = pgTable(
    "mira_browser_commands",
    {
        id: uuid()
            .primaryKey()
            .references(() => miraToolReceipts.id),
        owner: text().notNull(),
        accessId: uuid("access_id")
            .notNull()
            .references(() => miraBrowserAccess.id),
        runId: uuid("run_id")
            .notNull()
            .references(() => miraRuns.id),
        runLease: uuid("run_lease").notNull(),
        processId: uuid("process_id").references(() => miraBrowserProcesses.id),
        processToken: uuid("process_token"),
        method: text().notNull(),
        state: text().notNull().default("queued"),
        payload: jsonb(),
        result: jsonb(),
        createdAt: time("created_at").notNull().defaultNow(),
        expiresAt: time("expires_at").notNull(),
        claimedAt: time("claimed_at"),
        finishedAt: time("finished_at"),
    },
    (t) => [
        index("mira_browser_commands_owner").on(t.owner, t.state),
        index("mira_browser_commands_cleanup").on(t.state, t.expiresAt),
        uniqueIndex("mira_browser_commands_active")
            .on(t.accessId)
            .where(sql`${t.state} IN ('queued','claimed','completed')`),
        check(
            "mira_browser_commands_method",
            sql`${t.method} IN ('observe','navigate','act')`
        ),
        check(
            "mira_browser_commands_state",
            sql`${t.state} IN ('queued','claimed','completed','consumed','refused','unknown')`
        ),
        check(
            "mira_browser_commands_duration",
            sql`${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '100 seconds'`
        ),
        check(
            "mira_browser_commands_binding",
            sql`(${t.processId} IS NULL AND ${t.processToken} IS NULL AND ${t.state} IN ('queued','refused','unknown')) OR (${t.processId} IS NOT NULL AND ${t.processToken} IS NOT NULL AND ${t.state}<>'queued')`
        ),
        check(
            "mira_browser_commands_payload",
            sql`(${t.state}='queued' AND ${t.payload} IS NOT NULL AND ${t.result} IS NULL) OR (${t.state}='claimed' AND ${t.payload} IS NULL AND ${t.result} IS NULL) OR (${t.state}='completed' AND ${t.payload} IS NULL AND ${t.result} IS NOT NULL) OR (${t.state} IN ('consumed','refused','unknown') AND ${t.payload} IS NULL AND ${t.result} IS NULL)`
        ),
        check(
            "mira_browser_commands_size",
            sql`(${t.payload} IS NULL OR octet_length(${t.payload}::text)<=32768) AND (${t.result} IS NULL OR octet_length(${t.result}::text)<=4194304)`
        ),
    ]
);

export const miraBrowserConsoles = pgTable(
    "mira_browser_consoles",
    {
        accessId: uuid("access_id")
            .primaryKey()
            .references(() => miraBrowserAccess.id),
        controller: text().notNull().default("mira"),
        epoch: uuid().notNull(),
        attempts: jsonb()
            .notNull()
            .default(sql`'[]'::jsonb`),
        commandId: uuid("command_id"),
        state: text().notNull().default("idle"),
        method: text(),
        payload: jsonb(),
        expiresAt: time("expires_at"),
        frame: jsonb(),
        frameAt: time("frame_at"),
    },
    (t) => [
        check(
            "mira_browser_console_controller",
            sql`${t.controller} IN ('mira','human')`
        ),
        check(
            "mira_browser_console_state",
            sql`(${t.state}='idle' AND ${t.payload} IS NULL AND ${t.method} IS NULL AND ${t.expiresAt} IS NULL) OR (${t.state} IN ('queued','claimed') AND ${t.controller}='human' AND ${t.commandId} IS NOT NULL AND ${t.method} IN ('observe','navigate','act') AND ${t.expiresAt} IS NOT NULL AND ((${t.state}='queued' AND ${t.payload} IS NOT NULL) OR (${t.state}='claimed' AND ${t.payload} IS NULL)))`
        ),
        check(
            "mira_browser_console_size",
            sql`(${t.payload} IS NULL OR octet_length(${t.payload}::text)<=32768) AND (${t.frame} IS NULL OR octet_length(${t.frame}::text)<=4194304) AND jsonb_typeof(${t.attempts})='array' AND jsonb_array_length(${t.attempts})<=128`
        ),
        check(
            "mira_browser_console_frame",
            sql`(${t.frame} IS NULL) = (${t.frameAt} IS NULL)`
        ),
    ]
);
