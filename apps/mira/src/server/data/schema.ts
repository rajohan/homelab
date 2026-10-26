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
