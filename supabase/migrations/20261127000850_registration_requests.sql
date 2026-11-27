-- 008F1: Controlled account access requests.
-- A verified sign-in can request a role, but cannot assign one.
begin;

create function public.request_toolbox_access(
    p_display_name text,
    p_requested_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_unit_id uuid;
    v_request_id uuid;
begin
    if v_user_id is null or not exists (
        select 1 from auth.users u
        where u.id = v_user_id
          and u.email is not null
          and u.email_confirmed_at is not null
    ) then
        raise exception 'Verified sign-in required';
    end if;

    if p_display_name is null
        or length(btrim(p_display_name)) not between 1 and 100
    then
        raise exception 'Enter a valid display name';
    end if;

    if p_requested_role is null
        or p_requested_role not in ('leader', 'parent', 'scout')
    then
        raise exception 'Invalid requested role';
    end if;

    select id into strict v_unit_id
    from public.units
    where slug = 'troop-120';

    if exists (
        select 1 from public.user_roles ur
        where ur.profile_id = v_user_id
          and ur.unit_id = v_unit_id
          and ur.role_code = p_requested_role
    ) then
        raise exception 'Role already assigned';
    end if;

    insert into public.profiles (id, display_name)
    values (v_user_id, btrim(p_display_name))
    on conflict (id) do nothing;

    insert into public.access_requests (
        profile_id, unit_id, requested_role
    )
    values (v_user_id, v_unit_id, p_requested_role)
    on conflict (profile_id, unit_id, requested_role)
        where status = 'pending'
    do nothing
    returning id into v_request_id;

    if v_request_id is not null then
        insert into public.audit_logs (
            unit_id, actor_profile_id, action,
            entity_type, entity_id
        )
        values (
            v_unit_id, v_user_id, 'access.requested',
            'access_request', v_request_id
        );
    else
        select id into v_request_id
        from public.access_requests
        where profile_id = v_user_id
          and unit_id = v_unit_id
          and requested_role = p_requested_role
          and status = 'pending';

        if v_request_id is null then
            raise exception 'Request changed; refresh and try again';
        end if;
    end if;

    return v_request_id;
end;
$$;

revoke all on function
    public.request_toolbox_access(text, text)
    from public, anon, authenticated;

grant execute on function
    public.request_toolbox_access(text, text)
    to authenticated;

commit;

-- Verify function permissions and continued direct-write denial.
select
    p.proname as function_name,
    p.prosecdef as security_definer,
    has_function_privilege('anon', p.oid, 'EXECUTE')
        as anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE')
        as authenticated_can_execute,
    has_table_privilege('authenticated',
        'public.access_requests', 'INSERT, UPDATE, DELETE, TRUNCATE')
        as direct_request_write
from pg_catalog.pg_proc p
where p.oid = 'public.request_toolbox_access(text,text)'::regprocedure;
