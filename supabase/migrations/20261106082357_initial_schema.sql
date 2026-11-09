
-- Projects

CREATE TABLE public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (name ~ '[^[:space:]]'),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Project members

CREATE TABLE public.project_members (
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (project_id, user_id)
);


-- Meetings

CREATE TABLE public.meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (title ~ '[^[:space:]]'),
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Indexes

CREATE INDEX idx_project_members_user
    ON public.project_members(user_id, project_id);

CREATE INDEX idx_meetings_project_created
    ON public.meetings(project_id, created_at DESC);


-- Enable row-level security

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;


-- Restrict direct table access

REVOKE ALL ON TABLE
    public.projects,
    public.project_members,
    public.meetings
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
    public.projects,
    public.project_members,
    public.meetings
TO authenticated;


-- Private authorization helpers

CREATE SCHEMA meet2build_private;

REVOKE ALL ON SCHEMA meet2build_private
FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA meet2build_private
TO authenticated;


CREATE FUNCTION meet2build_private.is_project_member(
    p_project_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.project_members
        WHERE project_id = p_project_id
          AND user_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION meet2build_private.is_project_member(UUID)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION meet2build_private.is_project_member(UUID)
TO authenticated;


-- Read access policies

CREATE POLICY projects_member_select
ON public.projects
FOR SELECT
TO authenticated
USING (
    meet2build_private.is_project_member(id)
);

CREATE POLICY project_members_member_select
ON public.project_members
FOR SELECT
TO authenticated
USING (
    meet2build_private.is_project_member(project_id)
);

CREATE POLICY meetings_member_select
ON public.meetings
FOR SELECT
TO authenticated
USING (
    meet2build_private.is_project_member(project_id)
);


-- Create project and assign its first owner

CREATE FUNCTION meet2build_private.create_project(p_name TEXT)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_project public.projects%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF p_name IS NULL OR p_name !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'Project name cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.projects (name, created_by)
    VALUES (p_name, v_user_id)
    RETURNING * INTO v_project;

    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (v_project.id, v_user_id, 'owner');

    RETURN v_project;
END;
$$;


-- Create meeting within an accessible project

CREATE FUNCTION meet2build_private.create_meeting(
    p_project_id UUID,
    p_title TEXT
)
RETURNS public.meetings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_meeting public.meetings%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM public.projects
    WHERE id = p_project_id
    FOR SHARE;

    IF NOT FOUND OR NOT meet2build_private.is_project_member(p_project_id) THEN
        RAISE EXCEPTION 'Project access denied'
            USING ERRCODE = '42501';
    END IF;

    IF p_title IS NULL OR p_title !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'Meeting title cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.meetings (project_id, title, created_by)
    VALUES (p_project_id, p_title, v_user_id)
    RETURNING * INTO v_meeting;

    RETURN v_meeting;
END;
$$;


-- Public RPC entry points

CREATE FUNCTION public.create_project(p_name TEXT)
RETURNS public.projects
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT meet2build_private.create_project(p_name);
$$;


CREATE FUNCTION public.create_meeting(
    p_project_id UUID,
    p_title TEXT
)
RETURNS public.meetings
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT meet2build_private.create_meeting(p_project_id, p_title);
$$;


-- Function permissions

REVOKE ALL ON FUNCTION
    meet2build_private.create_project(TEXT),
    meet2build_private.create_meeting(UUID, TEXT),
    public.create_project(TEXT),
    public.create_meeting(UUID, TEXT)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.create_project(TEXT),
    meet2build_private.create_meeting(UUID, TEXT),
    public.create_project(TEXT),
    public.create_meeting(UUID, TEXT)
TO authenticated;
