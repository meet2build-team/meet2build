BEGIN;

CREATE TABLE public.meeting_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(id) ON DELETE RESTRICT,
    original_name TEXT NOT NULL CHECK (original_name ~ '[^[:space:]]'),
    format TEXT NOT NULL CHECK (format IN ('txt', 'mp3', 'wav')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'uploaded')),
        uploaded_at TIMESTAMPTZ,
    CONSTRAINT meeting_files_upload_state_check CHECK (
        (status = 'pending' AND uploaded_at IS NULL)
        OR
        (status = 'uploaded' AND uploaded_at IS NOT NULL)
    )
);

CREATE INDEX idx_meeting_files_meeting_created
    ON public.meeting_files (meeting_id, created_at DESC);

ALTER TABLE public.meeting_files ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.meeting_files
    FROM PUBLIC, anon, authenticated;

COMMIT;