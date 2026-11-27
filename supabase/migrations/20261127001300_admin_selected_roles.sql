-- 013A: Administrator-selected roles; applicants request access only.
-- Preserve historical requests, account links and assigned roles.
begin;

alter table public.access_requests
    alter column requested_role drop not null,
    add column assigned_role text references public.roles(code) on delete restrict
        check (assigned_role in ('leader','parent','scout'));

update public.access_requests
set assigned_role = requested_role
where status = 'approved';

alter table public.access_requests
    add constraint access_requests_approval_role_consistency_check
    check ((status = 'approved' and assigned_role is not null)
           or (status <> 'approved' and assigned_role is null));

-- Refuse to migrate if unresolved duplicate pending requests exist.
-- No existing records are deleted.
drop index public.access_requests_pending_idx;
create unique index access_requests_pending_idx
    on public.access_requests(profile_id, unit_id)
    where status = 'pending';

-- Remove the old client-callable interfaces so stale pages cannot
-- submit a role or approve one based on the applicant's choice.
drop function public.request_toolbox_access(text,text);
drop function public.review_toolbox_access(uuid,boolean,uuid);

create function public.request_toolbox_access(p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_unit uuid;
    v_request uuid;
begin
    if v_user is null or not exists (
        select 1 from auth.users u
        where u.id = v_user and u.email is not null
          and u.email_confirmed_at is not null
    ) then
        raise exception 'Verified sign-in required';
    end if;
    if p_display_name is null or length(btrim(p_display_name)) not between 1 and 100 then
        raise exception 'Enter a valid display name';
    end if;
    select id into strict v_unit from public.units where slug = 'troop-120';
    insert into public.profiles (id,display_name)
    values (v_user,btrim(p_display_name)) on conflict (id) do nothing;

    insert into public.access_requests (profile_id,unit_id)
    values (v_user,v_unit)
    on conflict (profile_id,unit_id) where status = 'pending' do nothing
    returning id into v_request;

    if v_request is null then
        select id into v_request from public.access_requests
        where profile_id = v_user and unit_id = v_unit and status = 'pending';
        if v_request is null then
            raise exception 'Request changed; refresh and try again';
        end if;
    else
        insert into public.audit_logs (unit_id,actor_profile_id,action,entity_type,entity_id)
        values (v_unit,v_user,'access.requested','access_request',v_request);
    end if;
    return v_request;
end;
$$;

create function public.review_toolbox_access(
    p_request_id uuid,
    p_approve boolean,
    p_member_id uuid,
    p_assigned_role text
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

    if not p_approve and p_assigned_role is not null then
        raise exception 'Denied requests cannot assign a role';
    end if;

    if p_approve then
        if p_assigned_role is null or p_assigned_role not in ('leader','parent','scout') then
            raise exception 'Administrator must select a valid role';
        end if;
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
            (p_assigned_role = 'scout'
                and v_member.member_type = 'youth')
            or
            (p_assigned_role in ('parent', 'leader')
                and v_member.member_type = 'adult')
        ) then
            raise exception 'Member type does not match role';
        end if;

        if p_assigned_role = 'parent'
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
            p_assigned_role
        )
        on conflict (profile_id, unit_id, role_code) do nothing;
    end if;

    if p_approve then
        insert into public.audit_logs (unit_id, actor_profile_id, action, entity_type, entity_id)
        values (v_request.unit_id, v_actor, 'role.granted.' || p_assigned_role, 'member', p_member_id);
    end if;

    update public.access_requests
    set status = case when p_approve then 'approved' else 'denied' end,
        assigned_role = case when p_approve then p_assigned_role else null end,
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


-- Grant an additional or restored role without requiring another request.
-- The account must already be associated with an active member.
create function public.grant_toolbox_member_role(
    p_unit_id uuid, p_member_id uuid, p_role_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_member public.members%rowtype;
    v_profile uuid;
begin
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
    if p_role_code is null or p_role_code not in ('leader','parent','scout') then
        raise exception 'Invalid role';
    end if;
    select m.* into v_member from public.members m
    where m.unit_id = p_unit_id and m.id = p_member_id and m.active
    for update;
    if not found then raise exception 'Select an active member in this unit'; end if;
    select ma.profile_id into v_profile from public.member_accounts ma
    where ma.unit_id = p_unit_id and ma.member_id = p_member_id;
    if not found then raise exception 'Member has no linked account'; end if;
    if v_profile = v_actor or exists (
        select 1 from public.user_roles ur
        where ur.profile_id = v_profile and ur.unit_id = p_unit_id and ur.role_code = 'admin'
    ) then raise exception 'Administrator account is protected'; end if;
    if not exists (
        select 1 from auth.users u
        where u.id = v_profile and u.email is not null and u.email_confirmed_at is not null
    ) then raise exception 'Applicant must have a verified email'; end if;
    if not ((p_role_code = 'scout' and v_member.member_type = 'youth')
        or (p_role_code in ('parent','leader') and v_member.member_type = 'adult')) then
        raise exception 'Member type does not match role';
    end if;
    if p_role_code = 'parent' and not exists (
        select 1 from public.family_relationships fr
        join public.members child on child.unit_id = fr.unit_id and child.id = fr.scout_member_id
        where fr.unit_id = p_unit_id and fr.adult_member_id = p_member_id and child.active
    ) then raise exception 'Verified family relationship required'; end if;

    insert into public.user_roles (profile_id,unit_id,role_code)
    values (v_profile,p_unit_id,p_role_code)
    on conflict (profile_id,unit_id,role_code) do nothing;
    if found then
        insert into public.audit_logs (unit_id,actor_profile_id,action,entity_type,entity_id)
        values (p_unit_id,v_actor,'role.granted.' || p_role_code,'member',p_member_id);
    end if;
end;
$$;

revoke all on function public.request_toolbox_access(text)
    from public,anon,authenticated;
revoke all on function public.review_toolbox_access(uuid,boolean,uuid,text)
    from public,anon,authenticated;
revoke all on function public.grant_toolbox_member_role(uuid,uuid,text)
    from public,anon,authenticated;
grant execute on function public.request_toolbox_access(text) to authenticated;
grant execute on function public.review_toolbox_access(uuid,boolean,uuid,text) to authenticated;
grant execute on function public.grant_toolbox_member_role(uuid,uuid,text) to authenticated;

-- Keep the existing directory RPC signature; its role column represents
-- the administrator-assigned role for approved requests, otherwise null.
create or replace function public.list_toolbox_access_requests(p_unit_id uuid)
returns table (
    request_id uuid, applicant_name text, applicant_email text,
    email_verified boolean, requested_role text, request_status text,
    requested_at timestamptz, linked_member_id uuid
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
    return query
    select ar.id, pr.display_name, u.email::text,
           (u.email_confirmed_at is not null and u.email is not null),
           ar.assigned_role, ar.status, ar.requested_at, ma.member_id
    from public.access_requests ar
    join public.profiles pr on pr.id = ar.profile_id
    join auth.users u on u.id = ar.profile_id
    left join public.member_accounts ma on ma.profile_id = ar.profile_id and ma.unit_id = ar.unit_id
    where ar.unit_id = p_unit_id
    order by (ar.status = 'pending') desc, ar.requested_at desc, ar.id
    limit 100;
end;
$$;

commit;

select p.proname as function_name, p.prosecdef as security_definer,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
       has_table_privilege('authenticated','public.user_roles','INSERT, UPDATE, DELETE, TRUNCATE') as direct_role_write
from pg_catalog.pg_proc p
where p.oid in (
    'public.request_toolbox_access(text)'::regprocedure,
    'public.review_toolbox_access(uuid,boolean,uuid,text)'::regprocedure,
    'public.grant_toolbox_member_role(uuid,uuid,text)'::regprocedure
)
order by p.proname;
