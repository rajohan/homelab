CREATE TABLE "mira_work_notes" (
	"id" uuid PRIMARY KEY,
	"run_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mira_messages" ADD COLUMN "attachment_replies" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "quotas" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "mira_work_notes_run" ON "mira_work_notes" ("run_id","created_at","id");--> statement-breakpoint
ALTER TABLE "mira_work_notes" ADD CONSTRAINT "mira_work_notes_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mira_automations" DROP CONSTRAINT "mira_automations_budget", ADD CONSTRAINT "mira_automations_budget" CHECK ("budget_seconds" between 30 and 3600);
--> statement-breakpoint
-- Older artifacts use their creation time to choose the nearest preceding reply.
UPDATE mira_messages m SET attachment_replies=coalesce((SELECT jsonb_object_agg(f.id,coalesce(
    (SELECT p.id::text FROM mira_message_replies p WHERE p.message_id=m.id AND p.created_at<=f.created_at ORDER BY p.created_at DESC,p.id DESC LIMIT 1),
    (SELECT p.id::text FROM mira_message_replies p WHERE p.message_id=m.id ORDER BY p.created_at,p.id LIMIT 1),m.id::text))
    FROM jsonb_array_elements_text(m.attachment_ids) a(id) JOIN mira_attachments f ON f.id::text=a.id),'{}'::jsonb)
WHERE jsonb_array_length(m.attachment_ids)>0;
--> statement-breakpoint
CREATE FUNCTION link_mira_reply_files() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE file_id text; reply_id text;
BEGIN
    IF jsonb_array_length(NEW.attachment_ids)=0 THEN NEW.attachment_replies='{}'::jsonb; RETURN NEW; END IF;
    IF jsonb_array_length(NEW.parts)>0 THEN
        SELECT coalesce(jsonb_object_agg(key,CASE WHEN value=to_jsonb(NEW.id::text) THEN NEW.parts->0->'id' ELSE value END),'{}'::jsonb)
            INTO NEW.attachment_replies FROM jsonb_each(NEW.attachment_replies);
    END IF;
    reply_id=coalesce(NEW.parts->-1->>'id',NEW.id::text);
    FOR file_id IN SELECT jsonb_array_elements_text(NEW.attachment_ids) LOOP
        IF NOT NEW.attachment_replies ? file_id THEN
            NEW.attachment_replies=jsonb_set(NEW.attachment_replies,ARRAY[file_id],to_jsonb(reply_id));
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mira_reply_files BEFORE INSERT OR UPDATE OF attachment_ids,parts ON mira_messages FOR EACH ROW EXECUTE FUNCTION link_mira_reply_files();
--> statement-breakpoint
CREATE FUNCTION record_mira_work_note() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id uuid; note text; addition text; previous_size integer; consumed integer; portion integer;
BEGIN
    note=NEW.activity->>'thinking';
    IF note IS NULL OR note='' THEN RETURN NEW; END IF;
    IF note IS NOT DISTINCT FROM OLD.activity->>'thinking'
        AND NEW.activity->>'thinkingId' IS NOT DISTINCT FROM OLD.activity->>'thinkingId'
        AND NEW.activity->>'thinkingOffset' IS NOT DISTINCT FROM OLD.activity->>'thinkingOffset' THEN RETURN NEW; END IF;
    addition=note;
    IF NEW.activity->>'thinkingId' IS NOT NULL AND NEW.activity->>'thinkingId'=OLD.activity->>'thinkingId' THEN
        consumed=coalesce((OLD.activity->>'thinkingOffset')::integer,0)+length(coalesce(OLD.activity->>'thinking',''))-coalesce((NEW.activity->>'thinkingOffset')::integer,0);
        addition=substring(note FROM greatest(0,consumed)+1);
        IF consumed<0 THEN addition=E'[Earlier note text was not observed]\n' || addition; END IF;
        SELECT id,length(content) INTO previous_id,previous_size FROM mira_work_notes WHERE run_id=NEW.id ORDER BY created_at DESC,id DESC LIMIT 1;
    ELSIF NEW.activity->>'thinkingId' IS NULL AND OLD.activity->>'thinkingId' IS NULL
        AND coalesce(OLD.activity->>'thinking','')<>'' AND starts_with(note,OLD.activity->>'thinking') THEN
        addition=substring(note FROM length(OLD.activity->>'thinking')+1);
        SELECT id,length(content) INTO previous_id,previous_size FROM mira_work_notes WHERE run_id=NEW.id ORDER BY created_at DESC,id DESC LIMIT 1;
    ELSIF coalesce((NEW.activity->>'thinkingOffset')::integer,0)>0 THEN
        addition=E'[Earlier note text was not observed]\n' || addition;
    END IF;
    WHILE length(addition)>0 LOOP
        IF previous_id IS NOT NULL AND previous_size<8000 THEN
            portion=least(8000-previous_size,length(addition));
            UPDATE mira_work_notes SET content=content || left(addition,portion) WHERE id=previous_id;
        ELSE
            portion=least(8000,length(addition));
            INSERT INTO mira_work_notes(id,run_id,content,created_at) VALUES(gen_random_uuid(),NEW.id,left(addition,portion),clock_timestamp());
        END IF;
        addition=substring(addition FROM portion+1);
        previous_id=NULL;
    END LOOP;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mira_work_note_changed AFTER UPDATE OF activity ON mira_runs FOR EACH ROW EXECUTE FUNCTION record_mira_work_note();
--> statement-breakpoint
INSERT INTO mira_work_notes(id,run_id,content) SELECT gen_random_uuid(),id,activity->>'thinking' FROM mira_runs WHERE coalesce(activity->>'thinking','')<>'';
--> statement-breakpoint
-- Upgrade existing short automation budgets without changing schedules or pause controls.
UPDATE mira_automations SET budget_seconds=900,version=version+1 WHERE deleted_at IS NULL AND budget_seconds<900;
