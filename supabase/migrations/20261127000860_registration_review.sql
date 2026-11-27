-- 008F2: Administrator review of account access requests.
-- Approval requires an existing, verified-by-admin, active member record.
begin;

create function public.review_toolbox_access(
    p_request_id uuid,
    p_approve boolean,
    p_member_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_request public.access_requests%rowtype;
    v_member public.members%rowtype;
begin
    if v_actor is null or p_approve is null then
        raise exception 'Invalid review';
    end if;

    select ar.* into v_request
    from public.access_requests ar
    where ar.id = p_request_id
      and toolbox_private.has_staff_access(ar.unit_id, true)
    for update;

    if not found then
        raise exception 'Request unavailable or access denied';
    end if;

    if v_request.profile_id = v_actor
        or v_request.status <> 'pending'
    then
        raise exception 'Request cannot be reviewed';
    end if;

    if p_approve then
        -- Serialize approvals for the same account.
        perform 1 from public.profiles
        where id = v_request.profile_id
        for update;

        if not exists (
            select 1 from auth.users u
            where u.id = v_request.profile_id
              and u.email is not null
              and u.email_confirmed_at is not null
        ) then
            raise exception 'Applicant must have a verified email';
        end if;

        select m.* into v_member
        from public.members m
        where m.id = p_member_id
          and m.unit_id = v_request.unit_id
          and m.active
        for update;

        if not found then
            raise exception 'Select an active member in this unit';
        end if;

        if not (
            (v_request.requested_role = 'scout'
                and v_member.member_type = 'youth')
            or
            (v_request.requested_role in ('parent', 'leader')
                and v_member.member_type = 'adult')
        ) then
            raise exception 'Member type does not match role';
        end if;

        if v_request.requested_role = 'parent'
            and not exists (
                select 1
                from public.family_relationships fr
                join public.members child
                  on child.unit_id = fr.unit_id
                 and child.id = fr.scout_member_id
                where fr.unit_id = v_request.unit_id
                  and fr.adult_member_id = v_member.id
                  and child.active
            )
        then
            raise exception 'Verified family relationship required';
        end if;

        insert into public.member_accounts (
            profile_id, unit_id, member_id
        )
        values (
            v_request.profile_id, v_request.unit_id, v_member.id
        )
        on conflict (profile_id, unit_id) do nothing;

        if not exists (
            select 1 from public.member_accounts ma
            where ma.profile_id = v_request.profile_id
              and ma.unit_id = v_request.unit_id
              and ma.member_id = v_member.id
        ) then
            raise exception 'Account is linked to a different member';
        end if;

        insert into public.user_roles (
            profile_id, unit_id, role_code
        )
        values (
            v_request.profile_id, v_request.unit_id,
            v_request.requested_role
        )
        on conflict (profile_id, unit_id, role_code) do nothing;
    end if;

    update public.access_requests
    set status = case when p_approve then 'approved' else 'denied' end,
        reviewed_at = clock_timestamp(),
        reviewed_by = v_actor
    where id = v_request.id;

    insert into public.audit_logs (
        unit_id, actor_profile_id, action, entity_type, entity_id
    )
    values (
        v_request.unit_id, v_actor,
        case when p_approve then 'access.approved' else 'access.denied' end,
        'access_request', v_request.id
    );
end;
$$;

revoke all on function
    public.review_toolbox_access(uuid, boolean, uuid)
    from public, anon, authenticated;

grant execute on function
    public.review_toolbox_access(uuid, boolean, uuid)
    to authenticated;

commit;

-- Verify function grants and continued denial of direct role assignment.
select
    p.proname as function_name,
    p.prosecdef as security_definer,
    has_function_privilege('anon', p.oid, 'EXECUTE')
        as anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE')
        as authenticated_can_execute,
    has_table_privilege('authenticated',
        'public.user_roles', 'INSERT, UPDATE, DELETE, TRUNCATE')
        as direct_role_write
from pg_catalog.pg_proc p
where p.oid =
    'public.review_toolbox_access(uuid,boolean,uuid)'::regprocedure;
