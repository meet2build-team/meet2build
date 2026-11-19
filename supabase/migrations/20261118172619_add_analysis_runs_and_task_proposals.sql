BEGIN;

CREATE TABLE public.analysis_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_version_id UUID NOT NULL
        REFERENCES public.transcript_versions(id) ON DELETE RESTRICT,
    model TEXT NOT NULL CHECK (model ~ '[^[:space:]]'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_analysis_runs_transcript_version
ON public.analysis_runs (transcript_version_id);

CREATE TABLE public.task_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_run_id UUID NOT NULL
        REFERENCES public.analysis_runs(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (title ~ '[^[:space:]]'),
    description TEXT,
    assignee TEXT,
    due_date DATE CHECK (due_date IS NULL OR isfinite(due_date)),
    source_start INTEGER,
    source_end INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    review_status TEXT NOT NULL DEFAULT 'pending_review'
        CHECK (review_status IN ('pending_review', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT task_proposals_source_range_check CHECK (
        (source_start IS NULL AND source_end IS NULL)
        OR (
            source_start IS NOT NULL
            AND source_end IS NOT NULL
            AND source_start >= 0
            AND source_end > source_start
        )
    )
);

CREATE INDEX idx_task_proposals_analysis_run
ON public.task_proposals (analysis_run_id);

ALTER TABLE public.analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_runs, public.task_proposals
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.analysis_runs, public.task_proposals
TO authenticated;

CREATE POLICY analysis_runs_member_select
ON public.analysis_runs
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.transcript_versions AS tv
        WHERE tv.id = analysis_runs.transcript_version_id
    )
);

CREATE POLICY task_proposals_member_select
ON public.task_proposals
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.analysis_runs AS ar
        WHERE ar.id = task_proposals.analysis_run_id
    )
);

CREATE FUNCTION meet2build_private.update_task_proposal(
    p_task_id UUID,
    p_expected_revision INTEGER,
    p_title TEXT,
    p_description TEXT,
    p_assignee TEXT,
    p_due_date DATE
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
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_task_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
        RAISE EXCEPTION 'A task ID and positive expected revision are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_title IS NULL OR p_title !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'Task title cannot be empty' USING ERRCODE = '22023';
    END IF;

    IF p_due_date IS NOT NULL AND NOT isfinite(p_due_date) THEN
        RAISE EXCEPTION 'Invalid due date' USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Task proposal editing requires READ COMMITTED'
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
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Task proposal not found';
    END IF;

    SELECT tp.* INTO v_task
    FROM public.task_proposals AS tp
    WHERE tp.id = p_task_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Task proposal not found';
    END IF;

    IF v_task.revision <> p_expected_revision THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'Task proposal revision conflict';
    END IF;

    IF ROW(v_task.title, v_task.description, v_task.assignee, v_task.due_date)
        IS NOT DISTINCT FROM
        ROW(p_title, p_description, p_assignee, p_due_date)
    THEN
        RETURN v_task;
    END IF;

    UPDATE public.task_proposals AS tp
    SET title = p_title,
        description = p_description,
        assignee = p_assignee,
        due_date = p_due_date,
        revision = tp.revision + 1,
        review_status = CASE
            WHEN tp.review_status = 'approved' THEN 'pending_review'
            ELSE tp.review_status
        END
    WHERE tp.id = p_task_id
    RETURNING tp.* INTO v_task;

    RETURN v_task;
END;
$$;

CREATE FUNCTION public.update_task_proposal(
    p_task_id UUID,
    p_expected_revision INTEGER,
    p_title TEXT,
    p_description TEXT,
    p_assignee TEXT,
    p_due_date DATE
)
RETURNS public.task_proposals
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.update_task_proposal(
        p_task_id,
        p_expected_revision,
        p_title,
        p_description,
        p_assignee,
        p_due_date
    );
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.update_task_proposal(UUID, INTEGER, TEXT, TEXT, TEXT, DATE),
    public.update_task_proposal(UUID, INTEGER, TEXT, TEXT, TEXT, DATE)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.update_task_proposal(UUID, INTEGER, TEXT, TEXT, TEXT, DATE),
    public.update_task_proposal(UUID, INTEGER, TEXT, TEXT, TEXT, DATE)
TO authenticated;

COMMIT;