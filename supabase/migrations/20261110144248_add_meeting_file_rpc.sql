BEGIN;

CREATE FUNCTION meet2build_private.register_meeting_file(
    p_meeting_id UUID,
    p_original_name TEXT,
    p_format TEXT,
    p_size_bytes BIGINT
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
    v_user_id UUID := auth.uid();
    v_file_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF p_meeting_id IS NULL THEN
        RAISE EXCEPTION 'Meeting ID is required'
            USING ERRCODE = '22023';
    END IF;

    IF p_original_name IS NULL OR p_original_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'File name cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF char_length(p_original_name) > 255 THEN
        RAISE EXCEPTION 'File name cannot exceed 255 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_format IS NULL OR p_format NOT IN ('txt', 'mp3', 'wav') THEN
        RAISE EXCEPTION 'Unsupported file format'
            USING ERRCODE = '22023';
    END IF;

    IF lower(right(p_original_name, 4) COLLATE pg_catalog."C")
       <> ('.' || p_format) THEN
        RAISE EXCEPTION 'File extension does not match declared format'
            USING ERRCODE = '22023';
    END IF;

    IF p_size_bytes IS NULL OR p_size_bytes NOT BETWEEN 1 AND 52428800 THEN
        RAISE EXCEPTION 'File size must be between 1 byte and 50 MiB'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.meeting_files AS f (
        meeting_id,
        original_name,
        format,
        size_bytes,
        created_by,
        created_at
    )
    SELECT
        m.id,
        p_original_name,
        p_format,
        p_size_bytes,
        v_user_id,
        clock_timestamp()
    FROM public.meetings AS m
    WHERE m.id = p_meeting_id
      AND meet2build_private.is_project_member(m.project_id)
    RETURNING f.id INTO v_file_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project access denied'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM public.meetings AS m
    JOIN public.project_members AS pm ON pm.project_id = m.project_id
    WHERE m.id = p_meeting_id
      AND pm.user_id = v_user_id
    FOR KEY SHARE OF pm;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project access denied'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT v_file_id, p_meeting_id::TEXT || '/' || v_file_id::TEXT;
END;
$$;

CREATE FUNCTION meet2build_private.confirm_meeting_file_upload(
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

    IF v_confirmed_at >= v_file.created_at + INTERVAL '48 hours' THEN
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

CREATE FUNCTION public.register_meeting_file(
    p_meeting_id UUID,
    p_original_name TEXT,
    p_format TEXT,
    p_size_bytes BIGINT
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
    SELECT *
    FROM meet2build_private.register_meeting_file(
        p_meeting_id,
        p_original_name,
        p_format,
        p_size_bytes
    );
$$;

CREATE FUNCTION public.confirm_meeting_file_upload(
    p_file_id UUID
)
RETURNS TABLE (
    file_id UUID,
    status TEXT,
    uploaded_at TIMESTAMPTZ
)
LANGUAGE SQL
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.confirm_meeting_file_upload(p_file_id);
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.register_meeting_file(UUID, TEXT, TEXT, BIGINT),
    meet2build_private.confirm_meeting_file_upload(UUID),
    public.register_meeting_file(UUID, TEXT, TEXT, BIGINT),
    public.confirm_meeting_file_upload(UUID)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.register_meeting_file(UUID, TEXT, TEXT, BIGINT),
    meet2build_private.confirm_meeting_file_upload(UUID),
    public.register_meeting_file(UUID, TEXT, TEXT, BIGINT),
    public.confirm_meeting_file_upload(UUID)
TO authenticated;

COMMIT;