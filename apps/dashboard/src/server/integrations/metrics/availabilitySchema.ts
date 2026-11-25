import { bit, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const availabilityBackfill = pgTable(
    "availability_backfill",
    {
        kind: text().notNull(),
        resource: text().notNull(),
        nextDay: integer("next_day").notNull(),
        firstMinute: integer("first_minute"),
    },
    (row) => [primaryKey({ columns: [row.kind, row.resource] })]
);

export const availabilityDays = pgTable(
    "availability_days",
    {
        kind: text().notNull(),
        resource: text().notNull(),
        day: integer().notNull(),
        firstMinute: integer("first_minute").notNull(),
        observed: bit({ dimensions: 1440 }).notNull(),
        healthy: bit({ dimensions: 1440 }).notNull(),
    },
    (row) => [primaryKey({ columns: [row.kind, row.resource, row.day] })]
);
