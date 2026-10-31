import { sql } from "drizzle-orm";
import {
    check,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const releaseDeployments = pgTable(
    "release_deployments",
    {
        id: uuid().primaryKey(),
        target: text().notNull(),
        requestedBy: text("requested_by").notNull(),
        requestKey: text("request_key").notNull().unique(),
        confirmationRevision: text("confirmation_revision").notNull(),
        configuration: text().notNull(),
        plan: jsonb().$type<Record<string, unknown>>().notNull(),
        state: text().notNull(),
        phase: text().notNull(),
        message: text(),
        receipt: jsonb().$type<Record<string, unknown>>(),
        controller: uuid(),
        leaseToken: uuid("lease_token"),
        leaseExpiresAt: time("lease_expires_at"),
        createdAt: time("created_at").notNull().defaultNow(),
        updatedAt: time("updated_at").notNull().defaultNow(),
        finishedAt: time("finished_at"),
    },
    (table) => [
        uniqueIndex("release_deployments_active")
            .on(sql`(true)`)
            .where(sql`${table.finishedAt} is null`),
        index("release_deployments_history").on(table.id.desc()),
        check(
            "release_deployments_state",
            sql`${table.state} in ('waiting','submitting','running','succeeded','failed','cancelled','unknown')`
        ),
        check(
            "release_deployments_completion",
            sql`(${table.state} in ('succeeded','cancelled') and ${table.finishedAt} is not null) or (${table.state} in ('waiting','submitting','running','unknown') and ${table.finishedAt} is null) or ${table.state} = 'failed'`
        ),
        check(
            "release_deployments_lease",
            sql`(${table.controller} is null and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null) or (${table.controller} is not null and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`
        ),
        check(
            "release_deployments_configuration",
            sql`${table.configuration} ~ '^[a-f0-9]{64}$'`
        ),
        check(
            "release_deployments_message",
            sql`${table.message} is null or length(${table.message}) between 1 and 500`
        ),
    ]
);
