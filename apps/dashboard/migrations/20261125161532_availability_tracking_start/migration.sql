ALTER TABLE "availability_backfill" ADD COLUMN "first_minute" integer;
--> statement-breakpoint
INSERT INTO availability_backfill AS cursor (kind, resource, next_day, first_minute)
SELECT kind, resource, floor(extract(epoch FROM now()) / 86400)::integer - 365, min(day * 1440 + first_minute)
FROM availability_days
GROUP BY kind, resource
ON CONFLICT (kind, resource) DO UPDATE SET first_minute = least(cursor.first_minute, excluded.first_minute);
