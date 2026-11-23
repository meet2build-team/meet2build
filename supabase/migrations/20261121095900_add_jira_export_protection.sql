BEGIN;

CREATE TABLE public.jira_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL
        REFERENCES public.task_proposals(id) ON DELETE RESTRICT,
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    jira_site_url TEXT NOT NULL CHECK (jira_site_url ~ '[^[:space:]]'),
    jira_project_id TEXT NOT NULL CHECK (jira_project_id ~ '[^[:space:]]'),
    task_snapshot JSONB NOT NULL
        CHECK (jsonb_typeof(task_snapshot) = 'object'),
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'succeeded', 'failed', 'unknown')),
    created_by UUID NOT NULL
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    jira_issue_id TEXT CHECK (jira_issue_id ~ '[^[:space:]]'),
    jira_issue_key TEXT CHECK (jira_issue_key ~ '[^[:space:]]'),
    error_message TEXT CHECK (error_message ~ '[^[:space:]]'),

    CONSTRAINT jira_exports_state_check CHECK (
        ((status = 'succeeded') = (jira_issue_id IS NOT NULL))
        AND ((status = 'succeeded') = (jira_issue_key IS NOT NULL))
        AND ((status IN ('failed', 'unknown')) = (error_message IS NOT NULL))
        AND ((status = 'processing') = (finished_at IS NULL))
    )
);

CREATE INDEX idx_jira_exports_task_created
ON public.jira_exports (task_id, created_at DESC);

CREATE UNIQUE INDEX uq_jira_exports_reserved_task
ON public.jira_exports (task_id)
WHERE status IN ('processing', 'unknown', 'succeeded');

ALTER TABLE public.jira_exports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.jira_exports
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.jira_exports
TO authenticated, service_role;

CREATE POLICY jira_exports_member_select
ON public.jira_exports
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.task_proposals AS tp
        WHERE tp.id = jira_exports.task_id
    )
);

CREATE FUNCTION meet2build_private.guard_task_proposal_export()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Task proposal changes require READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    IF NEW IS DISTINCT FROM OLD AND EXISTS (
        SELECT 1
        FROM public.jira_exports AS je
        WHERE je.task_id = OLD.id
          AND je.status IN ('processing', 'unknown', 'succeeded')
    ) THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Task proposal is locked by Jira export';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER task_proposals_export_guard
BEFORE UPDATE ON public.task_proposals
FOR EACH ROW
EXECUTE FUNCTION meet2build_private.guard_task_proposal_export();

CREATE FUNCTION meet2build_private.begin_jira_export(
    p_task_id UUID,
    p_expected_revision INTEGER,
    p_jira_site_url TEXT,
    p_jira_project_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_site_url TEXT := rtrim(btrim(p_jira_site_url), '/');
    v_jira_project_id TEXT := btrim(p_jira_project_id);
    v_project_id UUID;
    v_task public.task_proposals%ROWTYPE;
    v_export public.jira_exports%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
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

    IF v_site_url IS NULL
        OR v_site_url !~ '[^[:space:]]'
        OR v_jira_project_id IS NULL
        OR v_jira_project_id !~ '[^[:space:]]'
    THEN
        RAISE EXCEPTION 'A Jira site URL and project ID are required'
            USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Jira export requires READ COMMITTED'
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

    IF v_task.review_status <> 'approved' THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Task proposal must be approved before Jira export';
    END IF;

    SELECT je.* INTO v_export
    FROM public.jira_exports AS je
    WHERE je.task_id = p_task_id
      AND je.status IN ('processing', 'unknown', 'succeeded');

    IF FOUND THEN
        RETURN jsonb_build_object(
            'should_send', FALSE,
            'export', to_jsonb(v_export)
        );
    END IF;

    INSERT INTO public.jira_exports (
        task_id,
        task_revision,
        jira_site_url,
        jira_project_id,
        task_snapshot,
        created_by
    )
    VALUES (
        v_task.id,
        v_task.revision,
        v_site_url,
        v_jira_project_id,
        to_jsonb(v_task),
        v_user_id
    )
    RETURNING * INTO v_export;

    RETURN jsonb_build_object(
        'should_send', TRUE,
        'export', to_jsonb(v_export)
    );
END;
$$;

CREATE FUNCTION meet2build_private.finish_jira_export(
    p_export_id UUID,
    p_status TEXT,
    p_jira_issue_id TEXT DEFAULT NULL,
    p_jira_issue_key TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL,
    p_verified_no_issue BOOLEAN DEFAULT FALSE
)
RETURNS public.jira_exports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_export public.jira_exports%ROWTYPE;
BEGIN
    IF p_export_id IS NULL THEN
        RAISE EXCEPTION 'Export ID is required'
            USING ERRCODE = '22023';
    END IF;

    IF p_status IS NULL
        OR p_status NOT IN ('succeeded', 'failed', 'unknown')
    THEN
        RAISE EXCEPTION 'Invalid Jira export result'
            USING ERRCODE = '22023';
    END IF;

    IF p_status = 'succeeded' THEN
        IF p_jira_issue_id IS NULL
            OR p_jira_issue_id !~ '[^[:space:]]'
            OR p_jira_issue_key IS NULL
            OR p_jira_issue_key !~ '[^[:space:]]'
            OR p_error_message IS NOT NULL
        THEN
            RAISE EXCEPTION 'Successful export requires an issue ID and key without an error'
                USING ERRCODE = '22023';
        END IF;
    ELSE
        IF p_jira_issue_id IS NOT NULL
            OR p_jira_issue_key IS NOT NULL
            OR p_error_message IS NULL
            OR p_error_message !~ '[^[:space:]]'
        THEN
            RAISE EXCEPTION 'Failed or unknown export requires an error without issue identifiers'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Jira export completion requires READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    SELECT je.* INTO v_export
    FROM public.jira_exports AS je
    WHERE je.id = p_export_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404'
            USING MESSAGE = 'Jira export not found';
    END IF;

    IF ROW(
        v_export.status,
        v_export.jira_issue_id,
        v_export.jira_issue_key,
        v_export.error_message
    ) IS NOT DISTINCT FROM ROW(
        p_status,
        p_jira_issue_id,
        p_jira_issue_key,
        p_error_message
    ) THEN
        RETURN v_export;
    END IF;

    IF v_export.status IN ('succeeded', 'failed') THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Jira export is already finalized';
    END IF;

    IF v_export.status = 'unknown'
        AND p_status = 'failed'
        AND p_verified_no_issue IS DISTINCT FROM TRUE
    THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Unknown Jira export requires verification before retry';
    END IF;

    UPDATE public.jira_exports AS je
    SET status = p_status,
        finished_at = clock_timestamp(),
        jira_issue_id = p_jira_issue_id,
        jira_issue_key = p_jira_issue_key,
        error_message = p_error_message
    WHERE je.id = p_export_id
    RETURNING je.* INTO v_export;

    RETURN v_export;
END;
$$;

CREATE FUNCTION public.begin_jira_export(
    p_task_id UUID,
    p_expected_revision INTEGER,
    p_jira_site_url TEXT,
    p_jira_project_id TEXT
)
RETURNS JSONB
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT meet2build_private.begin_jira_export(
        p_task_id,
        p_expected_revision,
        p_jira_site_url,
        p_jira_project_id
    );
$$;

CREATE FUNCTION public.finish_jira_export(
    p_export_id UUID,
    p_status TEXT,
    p_jira_issue_id TEXT DEFAULT NULL,
    p_jira_issue_key TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL,
    p_verified_no_issue BOOLEAN DEFAULT FALSE
)
RETURNS public.jira_exports
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.finish_jira_export(
        p_export_id,
        p_status,
        p_jira_issue_id,
        p_jira_issue_key,
        p_error_message,
        p_verified_no_issue
    );
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.guard_task_proposal_export(),
    meet2build_private.begin_jira_export(UUID, INTEGER, TEXT, TEXT),
    public.begin_jira_export(UUID, INTEGER, TEXT, TEXT),
    meet2build_private.finish_jira_export(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN),
    public.finish_jira_export(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.begin_jira_export(UUID, INTEGER, TEXT, TEXT),
    public.begin_jira_export(UUID, INTEGER, TEXT, TEXT)
TO authenticated;

GRANT EXECUTE ON FUNCTION
    meet2build_private.finish_jira_export(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN),
    public.finish_jira_export(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
TO service_role;

COMMIT;