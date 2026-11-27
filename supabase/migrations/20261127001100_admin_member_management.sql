-- 011C: Controlled member creation and administrator request identity lookup.
begin;

create function public.create_toolbox_member(
    p_unit_id uuid, p_display_name text, p_member_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_member_id uuid;
begin
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;

    if p_display_name is null or length(btrim(p_display_name)) not between 1 and 100 then
        raise exception 'Enter a valid member name';
    end if;
    if p_member_type is null or p_member_type not in ('adult', 'youth') then
        raise exception 'Invalid member type';
    end if;

    insert into public.members (unit_id, display_name, member_type)
    values (p_unit_id, btrim(p_display_name), p_member_type)
    returning id into v_member_id;

    insert into public.audit_logs (
        unit_id, actor_profile_id, action, entity_type, entity_id
    )
    values (p_unit_id, v_actor, 'member.created', 'member', v_member_id);

    return v_member_id;
end;
$$;

create function public.list_toolbox_access_requests(p_unit_id uuid)
returns table (
    request_id uuid,
    applicant_name text,
    applicant_email text,
    email_verified boolean,
    requested_role text,
    request_status text,
    requested_at timestamptz,
    linked_member_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;

    return query
    select ar.id, pr.display_name, u.email::text,
           (u.email_confirmed_at is not null and u.email is not null),
           ar.requested_role, ar.status, ar.requested_at, ma.member_id
    from public.access_requests ar
    join public.profiles pr on pr.id = ar.profile_id
    join auth.users u on u.id = ar.profile_id
    left join public.member_accounts ma
      on ma.profile_id = ar.profile_id and ma.unit_id = ar.unit_id
    where ar.unit_id = p_unit_id
    order by (ar.status = 'pending') desc, ar.requested_at desc, ar.id
    limit 100;
end;
$$;

revoke all on function public.create_toolbox_member(uuid, text, text)
    from public, anon, authenticated;
revoke all on function public.list_toolbox_access_requests(uuid)
    from public, anon, authenticated;

grant execute on function public.create_toolbox_member(uuid, text, text)
    to authenticated;
grant execute on function public.list_toolbox_access_requests(uuid)
    to authenticated;

commit;

-- Check function grants and continued direct-write restrictions.
select
    p.proname as function_name,
    p.prosecdef as security_definer,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
    has_table_privilege('authenticated', 'public.members',
        'INSERT, UPDATE, DELETE, TRUNCATE') as direct_member_write
from pg_catalog.pg_proc p
where p.oid in (
    'public.create_toolbox_member(uuid,text,text)'::regprocedure,
    'public.list_toolbox_access_requests(uuid)'::regprocedure
)
order by p.proname;
