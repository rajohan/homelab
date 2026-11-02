ALTER TABLE "mira_message_replies" ADD COLUMN "completed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_mira_message_replies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.parts IS NOT DISTINCT FROM OLD.parts
        AND NEW.role = OLD.role AND NEW.conversation_id = OLD.conversation_id
        AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;
    DELETE FROM mira_message_replies WHERE message_id = NEW.id;
    INSERT INTO mira_message_replies(id,message_id,conversation_id,"offset",end_offset,created_at,completed)
        SELECT (value->>'id')::uuid,NEW.id,NEW.conversation_id,(value->>'offset')::int,
            lead((value->>'offset')::int) OVER (ORDER BY ordinality),(value->>'createdAt')::timestamptz,
            coalesce(value->'completed'='true'::jsonb,false)
        FROM jsonb_array_elements(CASE WHEN NEW.role='assistant' AND jsonb_array_length(NEW.parts)>0
            THEN NEW.parts ELSE jsonb_build_array(jsonb_build_object('id',NEW.id,'offset',0,'createdAt',NEW.created_at)) END) WITH ORDINALITY;
    RETURN NEW;
END;
$$;
