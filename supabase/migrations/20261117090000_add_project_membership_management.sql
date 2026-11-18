BEGIN;

CREATE FUNCTION meet2build_private.lock_project_for_membership_change(
    p_project_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_role TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_project_id IS NULL THEN
        RAISE EXCEPTION 'Project ID is required' USING ERRCODE = '22023';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Membership changes require READ COMMITTED'
            USING ERRCODE = '0A000';
    END IF;

    PERFORM 1
    FROM public.projects AS p
    WHERE p.id = p_project_id
    FOR NO KEY UPDATE;

    SELECT pm.role INTO v_role
    FROM public.project_members AS pm
    WHERE pm.project_id = p_project_id AND pm.user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Project not found';
    END IF;

    IF v_role <> 'owner' THEN
        RAISE SQLSTATE 'PT403' USING MESSAGE = 'Project owner role required';
    END IF;
END;
$$;

CREATE FUNCTION meet2build_private.require_another_project_owner(
    p_project_id UUID,
    p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.project_members AS pm
        WHERE pm.project_id = p_project_id
          AND pm.role = 'owner'
          AND pm.user_id <> p_user_id
    ) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'Project must have at least one owner';
    END IF;
END;
$$;

CREATE FUNCTION meet2build_private.list_project_members(p_project_id UUID)
RETURNS TABLE (user_id UUID, email TEXT, role TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_project_id IS NULL THEN
        RAISE EXCEPTION 'Project ID is required' USING ERRCODE = '22023';
    END IF;

    -- Check membership and read the roster in the same snapshot.
    RETURN QUERY
    SELECT pm.user_id, u.email::TEXT, pm.role, pm.created_at
    FROM public.project_members AS pm
    JOIN auth.users AS u ON u.id = pm.user_id
    WHERE pm.project_id = p_project_id
      AND (SELECT meet2build_private.is_project_member(p_project_id))
    ORDER BY pm.created_at, pm.user_id;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Project not found';
    END IF;
END;
$$;

CREATE FUNCTION meet2build_private.add_project_member(
    p_project_id UUID,
    p_email TEXT,
    p_role TEXT
)
RETURNS public.project_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_email TEXT := lower(btrim(p_email));
    v_user_id UUID;
    v_member public.project_members%ROWTYPE;
BEGIN
    PERFORM meet2build_private.lock_project_for_membership_change(p_project_id);

    IF v_email IS NULL OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
        RAISE EXCEPTION 'Invalid email address' USING ERRCODE = '22023';
    END IF;

    IF p_role IS NULL OR p_role NOT IN ('owner', 'member') THEN
        RAISE EXCEPTION 'Invalid project role' USING ERRCODE = '22023';
    END IF;

    BEGIN
        SELECT u.id INTO STRICT v_user_id
        FROM auth.users AS u
        WHERE lower(u.email) = v_email;
    EXCEPTION
        WHEN no_data_found THEN
            RAISE SQLSTATE 'PT404' USING MESSAGE = 'User not found';
        WHEN too_many_rows THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'Email matches more than one user';
    END;

    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (p_project_id, v_user_id, p_role)
    ON CONFLICT (project_id, user_id) DO NOTHING
    RETURNING * INTO v_member;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'User is already a project member';
    END IF;

    RETURN v_member;
END;
$$;

CREATE FUNCTION meet2build_private.update_project_member_role(
    p_project_id UUID,
    p_user_id UUID,
    p_role TEXT
)
RETURNS public.project_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_member public.project_members%ROWTYPE;
BEGIN
    PERFORM meet2build_private.lock_project_for_membership_change(p_project_id);

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required' USING ERRCODE = '22023';
    END IF;

    IF p_role IS NULL OR p_role NOT IN ('owner', 'member') THEN
        RAISE EXCEPTION 'Invalid project role' USING ERRCODE = '22023';
    END IF;

    SELECT pm.* INTO v_member
    FROM public.project_members AS pm
    WHERE pm.project_id = p_project_id AND pm.user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Project member not found';
    END IF;

    IF v_member.role = p_role THEN
        RETURN v_member;
    END IF;

    IF v_member.role = 'owner' THEN
        PERFORM meet2build_private.require_another_project_owner(p_project_id, p_user_id);
    END IF;

    UPDATE public.project_members AS pm
    SET role = p_role
    WHERE pm.project_id = p_project_id AND pm.user_id = p_user_id
    RETURNING pm.* INTO v_member;

    RETURN v_member;
END;
$$;

CREATE FUNCTION meet2build_private.remove_project_member(
    p_project_id UUID,
    p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_role TEXT;
BEGIN
    PERFORM meet2build_private.lock_project_for_membership_change(p_project_id);

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required' USING ERRCODE = '22023';
    END IF;

    SELECT pm.role INTO v_role
    FROM public.project_members AS pm
    WHERE pm.project_id = p_project_id AND pm.user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'Project member not found';
    END IF;

    IF v_role = 'owner' THEN
        PERFORM meet2build_private.require_another_project_owner(p_project_id, p_user_id);
    END IF;

    DELETE FROM public.project_members AS pm
    WHERE pm.project_id = p_project_id AND pm.user_id = p_user_id;
END;
$$;

CREATE FUNCTION public.list_project_members(p_project_id UUID)
RETURNS TABLE (user_id UUID, email TEXT, role TEXT, created_at TIMESTAMPTZ)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT * FROM meet2build_private.list_project_members(p_project_id);
$$;

CREATE FUNCTION public.add_project_member(p_project_id UUID, p_email TEXT, p_role TEXT)
RETURNS public.project_members
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT * FROM meet2build_private.add_project_member(p_project_id, p_email, p_role);
$$;

CREATE FUNCTION public.update_project_member_role(p_project_id UUID, p_user_id UUID, p_role TEXT)
RETURNS public.project_members
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT * FROM meet2build_private.update_project_member_role(p_project_id, p_user_id, p_role);
$$;

CREATE FUNCTION public.remove_project_member(p_project_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE SQL
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT meet2build_private.remove_project_member(p_project_id, p_user_id);
$$;

REVOKE ALL ON FUNCTION
    meet2build_private.lock_project_for_membership_change(UUID),
    meet2build_private.require_another_project_owner(UUID, UUID),
    meet2build_private.list_project_members(UUID),
    meet2build_private.add_project_member(UUID, TEXT, TEXT),
    meet2build_private.update_project_member_role(UUID, UUID, TEXT),
    meet2build_private.remove_project_member(UUID, UUID),
    public.list_project_members(UUID),
    public.add_project_member(UUID, TEXT, TEXT),
    public.update_project_member_role(UUID, UUID, TEXT),
    public.remove_project_member(UUID, UUID)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    meet2build_private.list_project_members(UUID),
    meet2build_private.add_project_member(UUID, TEXT, TEXT),
    meet2build_private.update_project_member_role(UUID, UUID, TEXT),
    meet2build_private.remove_project_member(UUID, UUID),
    public.list_project_members(UUID),
    public.add_project_member(UUID, TEXT, TEXT),
    public.update_project_member_role(UUID, UUID, TEXT),
    public.remove_project_member(UUID, UUID)
TO authenticated;

COMMIT;
