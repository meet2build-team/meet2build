BEGIN;

CREATE FUNCTION meet2build_private.can_access_meeting_file(
    p_object_name TEXT,
    p_for_upload BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.meeting_files AS f
        JOIN public.meetings AS m
        ON m.id = f.meeting_id
        WHERE f.id = CASE
        WHEN split_part(p_object_name, '/', 2)
        COLLATE pg_catalog."C"
        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN split_part(p_object_name, '/', 2)::uuid
        END
        AND p_object_name COLLATE pg_catalog."C" =
        f.meeting_id::text || '/' || f.id::text
        AND meet2build_private.is_project_member(m.project_id)
        AND CASE
            WHEN p_for_upload THEN f.status = 'pending'
            AND f.created_by = auth.uid()
            AND f.created_at + INTERVAL '24 hour' > statement_timestamp()
            ELSE f.status = 'uploaded'
        END
    );
$$;

REVOKE ALL ON FUNCTION meet2build_private.can_access_meeting_file(TEXT, BOOLEAN)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION meet2build_private.can_access_meeting_file(TEXT, BOOLEAN)
TO authenticated;

CREATE POLICY meeting_files_download
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'meeting-files'
    AND storage.allow_only_operation('object.get_authenticated')
    AND meet2build_private.can_access_meeting_file(name, FALSE)
);

CREATE POLICY meeting_files_upload
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'meeting-files'
    AND storage.allow_only_operation('object.upload')
    AND meet2build_private.can_access_meeting_file(name, TRUE)
);

COMMIT;