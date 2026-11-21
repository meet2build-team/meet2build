BEGIN;

CREATE FUNCTION meet2build_private.review_task_proposal(
    p_task_id UUID,
    p_expected_revision INTEGER,
    p_review_status TEXT
)
RETURNS public.task_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_project_id UUID;
    v_task public.task_proposals%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF p_task_id IS NULL
        OR p_expected_revision IS NULL
        OR p_expected_revision < 1
    THEN
        RAISE EXCEPTION 'A task ID and positive expected revision are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_review_status IS NULL
        OR p_review_status NOT IN ('approved', 'rejected')
    THEN
        RAISE EXCEPTION 'Invalid review status'
            USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Task proposal review requires READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    SELECT p.id INTO v_project_id
    FROM public.task_proposals AS tp
    JOIN public.analysis_runs AS ar ON ar.id = tp.analysis_run_id
    JOIN public.transcript_versions AS tv ON tv.id = ar.transcript_version_id
    JOIN public.meetings AS m ON m.id = tv.meeting_id
    JOIN public.projects AS p ON p.id = m.project_id
    WHERE tp.id = p_task_id
    FOR SHARE OF p;

    IF NOT FOUND OR NOT meet2build_private.is_project_member(v_project_id) THEN
        RAISE SQLSTATE 'PT404'
            USING MESSAGE = 'Task proposal not found';
    END IF;

    SELECT tp.* INTO v_task
    FROM public.task_proposals AS tp
    WHERE tp.id = p_task_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404'
            USING MESSAGE = 'Task proposal not found';
    END IF;

    IF v_task.revision <> p_expected_revision THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Task proposal revision conflict';
    END IF;

    IF v_task.review_status = p_review_status THEN
        RETURN v_task;
    END IF;

    UPDATE public.task_proposals AS tp
    SET review_status = p_review_status
    WHERE tp.id = p_task_id
    RETURNING tp.* INTO v_task;

    RETURN v_task;
END;
$$;

CREATE FUNCTION public.approve_task_proposal(
    p_task_id UUID,
    p_expected_revision INTEGER
)
RETURNS public.task_proposals
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.review_task_proposal(
        p_task_id,
        p_expected_revision,
        'approved'
    );
$$;

CREATE FUNCTION public.reject_task_proposal(
    p_task_id UUID,
    p_expected_revision INTEGER
)
RETURNS public.task_proposals
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.review_task_proposal(
        p_task_id,
        p_expected_revision,
        'rejected'
    );
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.review_task_proposal(UUID, INTEGER, TEXT),
    public.approve_task_proposal(UUID, INTEGER),
    public.reject_task_proposal(UUID, INTEGER)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.review_task_proposal(UUID, INTEGER, TEXT),
    public.approve_task_proposal(UUID, INTEGER),
    public.reject_task_proposal(UUID, INTEGER)
TO authenticated;

COMMIT;