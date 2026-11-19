BEGIN;

CREATE FUNCTION meet2build_private.save_analysis_result(
    p_run_id UUID,
    p_transcript_version_id UUID,
    p_model TEXT,
    p_proposals JSONB
)
RETURNS public.analysis_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_project_id UUID;
    v_full_text TEXT;
    v_run public.analysis_runs%ROWTYPE;
    v_proposal JSONB;
    v_field TEXT;
    v_due_date DATE;
    v_date_text TEXT;
    v_quote TEXT;
    v_match INTEGER;
    v_source_start INTEGER;
    v_source_end INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF p_run_id IS NULL OR p_transcript_version_id IS NULL THEN
        RAISE EXCEPTION 'Run ID and transcript version ID are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_model IS NULL OR p_model !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'Model cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_proposals) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Proposals must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Analysis saving requires READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    SELECT m.project_id, tv.full_text
    INTO v_project_id, v_full_text
    FROM public.transcript_versions AS tv
    JOIN public.meetings AS m ON m.id = tv.meeting_id
    JOIN public.projects AS p ON p.id = m.project_id
    WHERE tv.id = p_transcript_version_id
    FOR SHARE OF p;

    IF NOT FOUND OR NOT meet2build_private.is_project_member(v_project_id) THEN
        RAISE SQLSTATE 'PT404'
            USING MESSAGE = 'Transcript version not found';
    END IF;

    INSERT INTO public.analysis_runs (
        id,
        transcript_version_id,
        model
    )
    VALUES (
        p_run_id,
        p_transcript_version_id,
        p_model
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_run;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Analysis run already exists';
    END IF;

    FOR v_proposal IN
        SELECT item.value
        FROM jsonb_array_elements(p_proposals) AS item(value)
    LOOP
        IF jsonb_typeof(v_proposal) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Each proposal must be a JSON object'
                USING ERRCODE = '22023';
        END IF;

        FOR v_field IN
            SELECT jsonb_object_keys(v_proposal)
        LOOP
            IF v_field NOT IN (
                'title',
                'description',
                'assignee',
                'due_date',
                'source_quote'
            ) THEN
                RAISE EXCEPTION 'Unknown proposal field: %', v_field
                    USING ERRCODE = '22023';
            END IF;

            IF jsonb_typeof(v_proposal -> v_field) NOT IN ('string', 'null') THEN
                RAISE EXCEPTION 'Proposal field % must be text or null', v_field
                    USING ERRCODE = '22023';
            END IF;
        END LOOP;

        IF jsonb_typeof(v_proposal -> 'title') IS DISTINCT FROM 'string'
            OR (v_proposal ->> 'title') !~ '[^[:space:]]'
        THEN
            RAISE EXCEPTION 'Task title cannot be empty'
                USING ERRCODE = '22023';
        END IF;

        v_due_date := NULL;
        v_date_text := v_proposal ->> 'due_date';

        IF v_date_text IS NOT NULL THEN
            IF v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
                RAISE EXCEPTION 'Due date must use YYYY-MM-DD'
                    USING ERRCODE = '22023';
            END IF;

            BEGIN
                v_due_date := v_date_text::DATE;
            EXCEPTION
                WHEN invalid_datetime_format OR datetime_field_overflow THEN
                    RAISE EXCEPTION 'Invalid due date'
                        USING ERRCODE = '22023';
            END;
        END IF;

        v_source_start := NULL;
        v_source_end := NULL;
        v_quote := v_proposal ->> 'source_quote';

        IF v_quote IS NOT NULL AND v_quote ~ '[^[:space:]]' THEN
            v_match := strpos(
                v_full_text COLLATE pg_catalog."C",
                v_quote COLLATE pg_catalog."C"
            );

            IF v_match > 0
                AND strpos(
                    substr(v_full_text, v_match + 1) COLLATE pg_catalog."C",
                    v_quote COLLATE pg_catalog."C"
                ) = 0
            THEN
                v_source_start := v_match - 1;
                v_source_end := v_source_start + char_length(v_quote);
            END IF;
        END IF;

        INSERT INTO public.task_proposals (
            analysis_run_id,
            title,
            description,
            assignee,
            due_date,
            source_start,
            source_end
        )
        VALUES (
            v_run.id,
            v_proposal ->> 'title',
            v_proposal ->> 'description',
            v_proposal ->> 'assignee',
            v_due_date,
            v_source_start,
            v_source_end
        );
    END LOOP;

    RETURN v_run;
END;
$$;

CREATE FUNCTION public.save_analysis_result(
    p_run_id UUID,
    p_transcript_version_id UUID,
    p_model TEXT,
    p_proposals JSONB DEFAULT '[]'::JSONB
)
RETURNS public.analysis_runs
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.save_analysis_result(
        p_run_id,
        p_transcript_version_id,
        p_model,
        p_proposals
    );
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.save_analysis_result(UUID, UUID, TEXT, JSONB),
    public.save_analysis_result(UUID, UUID, TEXT, JSONB)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.save_analysis_result(UUID, UUID, TEXT, JSONB),
    public.save_analysis_result(UUID, UUID, TEXT, JSONB)
TO authenticated;

COMMIT;