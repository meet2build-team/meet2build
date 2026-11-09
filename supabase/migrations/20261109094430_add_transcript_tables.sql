CREATE TABLE public.transcript_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    full_text TEXT NOT NULL CHECK (full_text ~ '[^[:space:]]'),
    segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (meeting_id, version_number)
);

CREATE TABLE public.transcript_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL
        REFERENCES public.transcript_versions(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    text TEXT NOT NULL CHECK (text <> ''),
    start_ms BIGINT CHECK (start_ms >= 0),
    end_ms BIGINT CHECK (end_ms >= 0),
    speaker_id TEXT,

    UNIQUE (version_id, position),
    CHECK (start_ms IS NULL OR end_ms IS NULL OR end_ms >= start_ms)
);

CREATE FUNCTION meet2build_private.check_transcript_segment_position()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_segment_count INTEGER;
BEGIN
    SELECT v.segment_count
    INTO v_segment_count
    FROM public.transcript_versions AS v
    WHERE v.id = NEW.version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transcript version is missing or inaccessible'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.position >= v_segment_count THEN
        RAISE EXCEPTION 'Transcript segment position is outside the declared range'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER transcript_segment_position_check
BEFORE INSERT ON public.transcript_segments
FOR EACH ROW
EXECUTE FUNCTION meet2build_private.check_transcript_segment_position();

-- The check can fire after the saving function has returned to its caller.
CREATE FUNCTION meet2build_private.check_transcript_segment_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (
        SELECT COUNT(*)
        FROM public.transcript_segments AS s
        WHERE s.version_id = NEW.id
    ) <> NEW.segment_count THEN
        RAISE EXCEPTION 'Transcript version has an incomplete segment set'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transcript_version_segment_count_check
AFTER INSERT ON public.transcript_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION meet2build_private.check_transcript_segment_count();

CREATE FUNCTION meet2build_private.reject_transcript_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'Transcript history is immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER transcript_versions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.transcript_versions
FOR EACH STATEMENT
EXECUTE FUNCTION meet2build_private.reject_transcript_history_mutation();

CREATE TRIGGER transcript_segments_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.transcript_segments
FOR EACH STATEMENT
EXECUTE FUNCTION meet2build_private.reject_transcript_history_mutation();

REVOKE ALL ON FUNCTION
    meet2build_private.check_transcript_segment_position(),
    meet2build_private.check_transcript_segment_count(),
    meet2build_private.reject_transcript_history_mutation()
FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.transcript_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_segments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.transcript_versions,
    public.transcript_segments
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
    public.transcript_versions,
    public.transcript_segments
TO authenticated;

CREATE POLICY transcript_versions_member_select
ON public.transcript_versions
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.meetings AS m
        WHERE m.id = transcript_versions.meeting_id
    )
);

CREATE POLICY transcript_segments_member_select
ON public.transcript_segments
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.transcript_versions AS v
        WHERE v.id = transcript_segments.version_id
    )
);