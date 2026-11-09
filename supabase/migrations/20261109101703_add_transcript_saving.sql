begin;

create function meet2build_private.save_transcript(
  p_meeting_id uuid,
  p_expected_version_id uuid,
  p_full_text text,
  p_segments jsonb
)
returns public.transcript_versions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_project_id uuid;
  v_segments jsonb := coalesce(nullif(p_segments, 'null'::jsonb), '[]'::jsonb);
  v_segment_count integer;
  v_segment jsonb;
  v_key text;
  v_value jsonb;
  v_number numeric;
  v_reconstructed text;
  v_current_id uuid;
  v_current_number integer;
  v_saved public.transcript_versions%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_meeting_id is null then
    raise exception using errcode = '22023', message = 'Meeting ID is required';
  end if;

  select m.project_id into v_project_id
  from public.meetings as m
  where m.id = p_meeting_id
    and meet2build_private.is_project_member(m.project_id);

  if not found then
    raise exception using errcode = '42501', message = 'Project access denied';
  end if;

  if p_full_text is null or p_full_text !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Transcript text must not be blank';
  end if;

  if jsonb_typeof(v_segments) <> 'array' then
    raise exception using errcode = '22023', message = 'Segments must be an array';
  end if;

  v_segment_count := jsonb_array_length(v_segments);

  for v_segment in
    select s.value from jsonb_array_elements(v_segments) as s(value)
  loop
    if jsonb_typeof(v_segment) <> 'object' then
      raise exception using errcode = '22023', message = 'Each segment must be an object';
    end if;

    if (v_segment - array['text', 'start_ms', 'end_ms', 'speaker_id']) <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Segment contains an unsupported field';
    end if;

    if jsonb_typeof(v_segment -> 'text') is distinct from 'string'
       or v_segment ->> 'text' = '' then
      raise exception using errcode = '22023', message = 'Segment text must be a nonempty string';
    end if;

    if (v_segment ->> 'speaker_id') is not null
       and (jsonb_typeof(v_segment -> 'speaker_id') <> 'string'
            or (v_segment ->> 'speaker_id') !~ '[^[:space:]]') then
      raise exception using errcode = '22023', message = 'Speaker ID must be a nonblank string or null';
    end if;

    foreach v_key in array array['start_ms', 'end_ms']
    loop
      v_value := v_segment -> v_key;
      if v_value is null or v_value = 'null'::jsonb then
        continue;
      end if;

      if jsonb_typeof(v_value) <> 'number' then
        raise exception using errcode = '22023',
          message = 'Segment timestamps must be nonnegative integer milliseconds or null';
      end if;

      v_number := (v_segment ->> v_key)::numeric;
      if v_number < 0 or v_number <> trunc(v_number)
         or v_number > 9223372036854775807::numeric then
        raise exception using errcode = '22023',
          message = 'Segment timestamps must be nonnegative integer milliseconds within bigint range';
      end if;
    end loop;

    if (v_segment ->> 'start_ms')::numeric > (v_segment ->> 'end_ms')::numeric then
      raise exception using errcode = '22023', message = 'Segment end precedes its start';
    end if;
  end loop;

  if v_segment_count > 0 then
    select string_agg(s.value ->> 'text', '' order by s.ordinality)
    into v_reconstructed
    from jsonb_array_elements(v_segments) with ordinality as s(value, ordinality);

    if (v_reconstructed collate pg_catalog."C") <> (p_full_text collate pg_catalog."C") then
      raise exception using errcode = '22023', message = 'Segment text does not reconstruct transcript text';
    end if;
  end if;

  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '0A000', message = 'Transcript saving requires READ COMMITTED';
  end if;

  -- Lock in project-to-meeting order. Membership changes must lock the project first.
  perform 1
  from public.projects as p
  where p.id = v_project_id
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'Project access denied';
  end if;

  if not meet2build_private.is_project_member(v_project_id) then
    raise exception using errcode = '42501', message = 'Project access denied';
  end if;

  perform 1
  from public.meetings as m
  where m.id = p_meeting_id and m.project_id = v_project_id
  for no key update;

  if not found then
    raise exception using errcode = '42501', message = 'Project access denied';
  end if;

  -- Read the latest committed version after acquiring the meeting lock.
  select v.id, v.version_number
  into v_current_id, v_current_number
  from public.transcript_versions as v
  where v.meeting_id = p_meeting_id
  order by v.version_number desc
  limit 1;

  if v_current_id is distinct from p_expected_version_id then
    raise sqlstate 'PT409' using message = 'Transcript version conflict';
  end if;

  insert into public.transcript_versions (
    meeting_id, version_number, full_text, segment_count, created_by
  )
  values (
    p_meeting_id, coalesce(v_current_number, 0) + 1,
    p_full_text, v_segment_count, v_user_id
  )
  returning * into v_saved;

  insert into public.transcript_segments (
    version_id, position, text, start_ms, end_ms, speaker_id
  )
  select
    v_saved.id,
    (s.ordinality - 1)::integer,
    s.value ->> 'text',
    (s.value ->> 'start_ms')::numeric::bigint,
    (s.value ->> 'end_ms')::numeric::bigint,
    s.value ->> 'speaker_id'
  from jsonb_array_elements(v_segments) with ordinality as s(value, ordinality);

  return v_saved;
end;
$$;

create function public.save_transcript(
  p_meeting_id uuid,
  p_expected_version_id uuid,
  p_full_text text,
  p_segments jsonb default '[]'::jsonb
)
returns public.transcript_versions
language sql
volatile
security invoker
set search_path = ''
as $$
  select *
  from meet2build_private.save_transcript(
    p_meeting_id, p_expected_version_id, p_full_text, p_segments
  );
$$;

revoke all on function meet2build_private.save_transcript(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.save_transcript(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function meet2build_private.save_transcript(uuid, uuid, text, jsonb)
  to authenticated;
grant execute on function public.save_transcript(uuid, uuid, text, jsonb)
  to authenticated;

commit;