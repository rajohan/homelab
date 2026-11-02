CREATE TABLE "mira_message_replies" (
	"id" uuid PRIMARY KEY,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"end_offset" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mira_message_replies_offsets" CHECK ("offset" >= 0 and ("end_offset" is null or "end_offset" >= "offset"))
);
--> statement-breakpoint
CREATE INDEX "mira_message_replies_conversation" ON "mira_message_replies" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "mira_message_replies_message" ON "mira_message_replies" ("message_id");--> statement-breakpoint
ALTER TABLE "mira_message_replies" ADD CONSTRAINT "mira_message_replies_message_id_mira_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "mira_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mira_message_replies" ADD CONSTRAINT "mira_message_replies_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");
--> statement-breakpoint
CREATE FUNCTION refresh_mira_message_replies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.parts IS NOT DISTINCT FROM OLD.parts
        AND NEW.role = OLD.role AND NEW.conversation_id = OLD.conversation_id
        AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;
    DELETE FROM mira_message_replies WHERE message_id = NEW.id;
    INSERT INTO mira_message_replies(id,message_id,conversation_id,"offset",end_offset,created_at)
        SELECT (value->>'id')::uuid,NEW.id,NEW.conversation_id,(value->>'offset')::int,
            lead((value->>'offset')::int) OVER (ORDER BY ordinality),(value->>'createdAt')::timestamptz
        FROM jsonb_array_elements(CASE WHEN NEW.role='assistant' AND jsonb_array_length(NEW.parts)>0
            THEN NEW.parts ELSE jsonb_build_array(jsonb_build_object('id',NEW.id,'offset',0,'createdAt',NEW.created_at)) END) WITH ORDINALITY;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mira_message_reply_boundaries AFTER INSERT OR UPDATE OF parts,role,conversation_id,created_at
    ON mira_messages FOR EACH ROW EXECUTE FUNCTION refresh_mira_message_replies();
--> statement-breakpoint
INSERT INTO mira_message_replies(id,message_id,conversation_id,"offset",end_offset,created_at)
    SELECT (p.value->>'id')::uuid,m.id,m.conversation_id,(p.value->>'offset')::int,
        lead((p.value->>'offset')::int) OVER (PARTITION BY m.id ORDER BY p.ordinality),(p.value->>'createdAt')::timestamptz
    FROM mira_messages m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN m.role='assistant' AND jsonb_array_length(m.parts)>0
        THEN m.parts ELSE jsonb_build_array(jsonb_build_object('id',m.id,'offset',0,'createdAt',m.created_at)) END) WITH ORDINALITY p;
