BEGIN;

ALTER TABLE public.meeting_files
    DROP CONSTRAINT meeting_files_status_check,
    DROP CONSTRAINT meeting_files_upload_state_check,
    ADD CONSTRAINT meeting_files_status_check
        CHECK (status IN ('pending', 'uploaded', 'cleaning')),
    ADD CONSTRAINT meeting_files_upload_state_check
        CHECK ((status = 'uploaded') = (uploaded_at IS NOT NULL));

CREATE FUNCTION meet2build_private.claim_expired_meeting_files(
    p_limit INTEGER,
    p_after_file_id UUID
)
RETURNS TABLE (
    file_id UUID,
    storage_path TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_cutoff TIMESTAMPTZ := clock_timestamp() - INTERVAL '48 hours';
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Cleanup batch size must be between 1 and 100'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS MATERIALIZED (
        SELECT f.id, f.meeting_id, f.status
        FROM public.meeting_files AS f
        WHERE (p_after_file_id IS NULL OR f.id > p_after_file_id)
          AND (
              f.status = 'cleaning'
              OR (f.status = 'pending' AND f.created_at < v_cutoff)
          )
        ORDER BY f.id
        LIMIT p_limit
        FOR UPDATE OF f SKIP LOCKED
    ),
    marked AS (
        UPDATE public.meeting_files AS f
        SET status = 'cleaning'
        FROM candidates AS c
        WHERE f.id = c.id
          AND c.status = 'pending'
          AND f.status = 'pending'
        RETURNING f.id, f.meeting_id
    )
    SELECT ready.id, ready.meeting_id::TEXT || '/' || ready.id::TEXT
    FROM (
        SELECT m.id, m.meeting_id
        FROM marked AS m
        UNION ALL
        SELECT c.id, c.meeting_id
        FROM candidates AS c
        WHERE c.status = 'cleaning'
    ) AS ready
    ORDER BY ready.id;
END;
$$;

CREATE FUNCTION meet2build_private.finalize_meeting_file_cleanup(
    p_file_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH deleted AS (
        DELETE FROM public.meeting_files AS f
        WHERE f.id = p_file_id
          AND f.status = 'cleaning'
          AND NOT EXISTS (
              SELECT 1
              FROM storage.objects AS o
              WHERE o.bucket_id = 'meeting-files'
                AND o.name COLLATE pg_catalog."C" =
                    f.meeting_id::TEXT || '/' || f.id::TEXT
                AND o.archived_at IS NULL
          )
        RETURNING f.id
    )
    SELECT EXISTS (SELECT 1 FROM deleted);
$$;

CREATE OR REPLACE FUNCTION meet2build_private.confirm_meeting_file_upload(
    p_file_id UUID
)
RETURNS TABLE (
    file_id UUID,
    status TEXT,
    uploaded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_file public.meeting_files%ROWTYPE;
    v_storage_path TEXT;
    v_object RECORD;
    v_confirmed_at TIMESTAMPTZ;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF p_file_id IS NULL THEN
        RAISE EXCEPTION 'File ID is required'
            USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'File confirmation requires READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    SELECT f.* INTO v_file
    FROM public.meeting_files AS f
    JOIN public.meetings AS m ON m.id = f.meeting_id
    WHERE f.id = p_file_id
      AND f.created_by = v_user_id
      AND meet2build_private.is_project_member(m.project_id)
    FOR NO KEY UPDATE OF f;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'File access denied'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM public.meetings AS m
    JOIN public.project_members AS pm ON pm.project_id = m.project_id
    WHERE m.id = v_file.meeting_id
      AND pm.user_id = v_user_id
    FOR KEY SHARE OF pm;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'File access denied'
            USING ERRCODE = '42501';
    END IF;

    IF v_file.status = 'uploaded' THEN
        RETURN QUERY
        SELECT v_file.id, v_file.status, v_file.uploaded_at;
        RETURN;
    END IF;

    v_storage_path := v_file.meeting_id::TEXT || '/' || v_file.id::TEXT;

    SELECT o.id, o.owner_id, o.metadata -> 'size' AS size_bytes, o.created_at
    INTO v_object
    FROM storage.objects AS o
    WHERE o.bucket_id = 'meeting-files'
      AND o.name COLLATE pg_catalog."C" = v_storage_path
      AND o.archived_at IS NULL;

    v_confirmed_at := clock_timestamp();

    IF v_file.status = 'cleaning'
       OR v_confirmed_at >= v_file.created_at + INTERVAL '48 hours' THEN
        RAISE SQLSTATE 'PT410'
            USING MESSAGE = 'File confirmation window expired';
    END IF;

    IF v_object.id IS NULL THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Uploaded file object not found';
    END IF;

    IF v_object.owner_id IS DISTINCT FROM v_file.created_by::TEXT THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Uploaded file owner does not match registration';
    END IF;

    IF v_object.size_bytes IS DISTINCT FROM to_jsonb(v_file.size_bytes) THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'Uploaded file size does not match registration';
    END IF;

    IF v_object.created_at IS NULL
       OR v_object.created_at < v_file.created_at
       OR v_object.created_at >= v_file.created_at + INTERVAL '24 hours' THEN
        RAISE SQLSTATE 'PT409'
            USING MESSAGE = 'File was not uploaded within the upload window';
    END IF;

    UPDATE public.meeting_files AS f
    SET status = 'uploaded',
        uploaded_at = v_confirmed_at
    WHERE f.id = v_file.id
    RETURNING f.* INTO v_file;

    RETURN QUERY
    SELECT v_file.id, v_file.status, v_file.uploaded_at;
END;
$$;

CREATE FUNCTION public.claim_expired_meeting_files(
    p_limit INTEGER DEFAULT 100,
    p_after_file_id UUID DEFAULT NULL
)
RETURNS TABLE (
    file_id UUID,
    storage_path TEXT
)
LANGUAGE SQL
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT c.file_id, c.storage_path
    FROM meet2build_private.claim_expired_meeting_files(
        p_limit,
        p_after_file_id
    ) AS c
    ORDER BY c.file_id;
$$;

CREATE FUNCTION public.finalize_meeting_file_cleanup(
    p_file_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT meet2build_private.finalize_meeting_file_cleanup(p_file_id);
$$;

GRANT USAGE ON SCHEMA meet2build_private TO service_role;

REVOKE ALL ON FUNCTION
    meet2build_private.claim_expired_meeting_files(INTEGER, UUID),
    meet2build_private.finalize_meeting_file_cleanup(UUID),
    public.claim_expired_meeting_files(INTEGER, UUID),
    public.finalize_meeting_file_cleanup(UUID)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.claim_expired_meeting_files(INTEGER, UUID),
    meet2build_private.finalize_meeting_file_cleanup(UUID),
    public.claim_expired_meeting_files(INTEGER, UUID),
    public.finalize_meeting_file_cleanup(UUID)
TO service_role;

COMMIT;