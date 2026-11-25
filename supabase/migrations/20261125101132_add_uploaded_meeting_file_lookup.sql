BEGIN;

CREATE FUNCTION meet2build_private.get_uploaded_meeting_file(
    p_meeting_id UUID,
    p_file_id UUID
)
RETURNS TABLE (
    storage_path TEXT,
    format TEXT,
    size_bytes BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        f.meeting_id::TEXT || '/' || f.id::TEXT,
        f.format,
        f.size_bytes
    FROM public.meeting_files AS f
    JOIN public.meetings AS m ON m.id = f.meeting_id
    WHERE f.id = p_file_id
      AND f.meeting_id = p_meeting_id
      AND f.status = 'uploaded'
      AND meet2build_private.is_project_member(m.project_id);
$$;

CREATE FUNCTION public.get_uploaded_meeting_file(
    p_meeting_id UUID,
    p_file_id UUID
)
RETURNS TABLE (
    storage_path TEXT,
    format TEXT,
    size_bytes BIGINT
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT *
    FROM meet2build_private.get_uploaded_meeting_file(
        p_meeting_id,
        p_file_id
    );
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.get_uploaded_meeting_file(UUID, UUID),
    public.get_uploaded_meeting_file(UUID, UUID)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.get_uploaded_meeting_file(UUID, UUID),
    public.get_uploaded_meeting_file(UUID, UUID)
TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;