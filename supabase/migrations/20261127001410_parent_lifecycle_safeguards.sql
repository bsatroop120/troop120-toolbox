-- 014E: Parent role lifecycle safeguards and temporary Scout account gate.
begin;

-- Serialize relevant administrative operations in each unit, before
-- taking member/request locks. No client can call this helper directly.
-- FOR NO KEY UPDATE avoids conflicting with ordinary foreign-key checks.
create function toolbox_private.lock_family_lifecycle(p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
    perform 1 from public.units where id = p_unit_id for no key update;
    if not found or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
end;
$$;
revoke all on function toolbox_private.lock_family_lifecycle(uuid)
    from public, anon, authenticated;

create or replace function public.set_toolbox_member_active(
    p_unit_id uuid, p_member_id uuid, p_active boolean
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
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;
    perform toolbox_private.lock_family_lifecycle(p_unit_id);
    if p_active is null then
        raise exception 'Invalid membership status';
    end if;

    select m.* into v_member
    from public.members m
    where m.unit_id = p_unit_id and m.id = p_member_id
    for update;
    if not found then
        raise exception 'Member unavailable';
    end if;

    select ma.profile_id into v_profile
    from public.member_accounts ma
    where ma.unit_id = p_unit_id and ma.member_id = p_member_id;

    if v_profile = v_actor or exists (
        select 1 from public.user_roles ur
        where ur.unit_id = p_unit_id and ur.profile_id = v_profile
          and ur.role_code = 'admin'
    ) then
        raise exception 'Administrator membership is protected';
    end if;

    if v_member.active = p_active and p_active then
        return;
    end if;

    -- Also clear stale roles before reactivation. Reapproval is required.
    delete from public.user_roles
    where unit_id = p_unit_id and profile_id = v_profile;

    update public.members set active = p_active
    where unit_id = p_unit_id and id = p_member_id;

    -- Keep the family links for history, but never keep a parent role
    -- when the last linked active Scout has become inactive.
    if not p_active and v_member.member_type = 'youth' then
        with revoked as (
            delete from public.user_roles ur
            using public.member_accounts ma, public.family_relationships fr
            where fr.unit_id = p_unit_id
              and fr.scout_member_id = p_member_id
              and ma.unit_id = fr.unit_id
              and ma.member_id = fr.adult_member_id
              and ur.unit_id = ma.unit_id
              and ur.profile_id = ma.profile_id
              and ur.role_code = 'parent'
              and not exists (
                  select 1 from public.family_relationships remaining
                  join public.members child
                    on child.unit_id = remaining.unit_id
                   and child.id = remaining.scout_member_id
                  where remaining.unit_id = fr.unit_id
                    and remaining.adult_member_id = fr.adult_member_id
                    and child.active
              )
            returning ma.member_id
        )
        insert into public.audit_logs
            (unit_id, actor_profile_id, action, entity_type, entity_id, details)
        select p_unit_id, v_actor, 'role.revoked.parent', 'member', member_id,
            jsonb_build_object('reason','no_active_linked_scout',
                               'scout_member_id',p_member_id)
        from revoked;
    end if;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id)
    values (p_unit_id, v_actor,
        case when p_active then 'member.reactivated' else 'member.deactivated' end,
        'member', p_member_id);
end;
$$;

create or replace function public.set_toolbox_family_relationship(
    p_unit_id uuid,
    p_adult_member_id uuid,
    p_scout_member_id uuid,
    p_relationship_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_old_type text;
begin
    if v_actor is null
       or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;
    perform toolbox_private.lock_family_lifecycle(p_unit_id);

    if p_relationship_type is null
       or p_relationship_type not in ('parent','guardian') then
        raise exception 'Invalid relationship type';
    end if;

    -- Use the same adult-member lock as role grant and approval.
    perform 1 from public.members
    where unit_id = p_unit_id and id = p_adult_member_id
      and member_type = 'adult' and active
    for update;
    if not found then
        raise exception 'Select an active adult in this unit';
    end if;

    perform 1 from public.members
    where unit_id = p_unit_id and id = p_scout_member_id
      and member_type = 'youth' and active
    for update;
    if not found then
        raise exception 'Select an active Scout in this unit';
    end if;

    select relationship_type into v_old_type
    from public.family_relationships
    where unit_id = p_unit_id
      and adult_member_id = p_adult_member_id
      and scout_member_id = p_scout_member_id;

    if v_old_type = p_relationship_type then return; end if;

    insert into public.family_relationships
        (unit_id, adult_member_id, scout_member_id, relationship_type)
    values (p_unit_id, p_adult_member_id, p_scout_member_id, p_relationship_type)
    on conflict (unit_id, adult_member_id, scout_member_id)
    do update set relationship_type = excluded.relationship_type;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id, details)
    values (
        p_unit_id, v_actor,
        case when v_old_type is null then 'family.linked' else 'family.updated' end,
        'member', p_adult_member_id,
        jsonb_build_object('scout_member_id', p_scout_member_id,
                           'previous_relationship_type', v_old_type,
                           'relationship_type', p_relationship_type)
    );
end;
$$;

create or replace function public.remove_toolbox_family_relationship(
    p_unit_id uuid,
    p_adult_member_id uuid,
    p_scout_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_old_type text;
    v_profile uuid;
begin
    if v_actor is null
       or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;
    perform toolbox_private.lock_family_lifecycle(p_unit_id);

    -- Permit removing historical links even when a member is inactive.
    perform 1 from public.members
    where unit_id = p_unit_id and id = p_adult_member_id
      and member_type = 'adult'
    for update;
    if not found then raise exception 'Adult member unavailable'; end if;

    delete from public.family_relationships
    where unit_id = p_unit_id
      and adult_member_id = p_adult_member_id
      and scout_member_id = p_scout_member_id
    returning relationship_type into v_old_type;

    if not found then raise exception 'Family relationship unavailable'; end if;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id, details)
    values (p_unit_id, v_actor, 'family.unlinked', 'member', p_adult_member_id,
        jsonb_build_object('scout_member_id', p_scout_member_id,
                           'previous_relationship_type', v_old_type));

    -- If no active linked Scout remains, remove only the parent role.
    -- Preserve any independently assigned leader or administrator role.
    if not exists (
        select 1 from public.family_relationships fr
        join public.members child on child.unit_id = fr.unit_id
          and child.id = fr.scout_member_id
        where fr.unit_id = p_unit_id
          and fr.adult_member_id = p_adult_member_id and child.active
    ) then
        select profile_id into v_profile from public.member_accounts
        where unit_id = p_unit_id and member_id = p_adult_member_id;

        delete from public.user_roles
        where unit_id = p_unit_id and profile_id = v_profile and role_code = 'parent';

        if found then
            insert into public.audit_logs
                (unit_id, actor_profile_id, action, entity_type, entity_id, details)
            values (p_unit_id, v_actor, 'role.revoked.parent', 'member',
                    p_adult_member_id,
                    jsonb_build_object('reason','no_active_linked_scout'));
        end if;
    end if;
end;
$$;

create or replace function public.grant_toolbox_member_role(
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
    perform toolbox_private.lock_family_lifecycle(p_unit_id);
    if p_role_code = 'scout' then
        raise exception 'Scout account assignment is not enabled pending consent safeguards';
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

create or replace function public.review_toolbox_access(
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
    v_unit uuid;
begin
    if v_actor is null or p_approve is null then
        raise exception 'Invalid review';
    end if;

    select ar.unit_id into v_unit
    from public.access_requests ar
    where ar.id = p_request_id
      and toolbox_private.has_staff_access(ar.unit_id, true);
    if not found then
        raise exception 'Request unavailable or access denied';
    end if;
    perform toolbox_private.lock_family_lifecycle(v_unit);

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
        if p_assigned_role = 'scout' then
            raise exception 'Scout account assignment is not enabled pending consent safeguards';
        end if;
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

-- Reconcile any stale parent role already present in the development database.
-- No membership or family records are deleted; no roles are granted.
with revoked as (
    delete from public.user_roles ur
    where ur.role_code = 'parent'
      and not exists (
          select 1 from public.member_accounts ma
          join public.members adult on adult.unit_id = ma.unit_id
            and adult.id = ma.member_id
          join public.family_relationships fr on fr.unit_id = ma.unit_id
            and fr.adult_member_id = ma.member_id
          join public.members child on child.unit_id = fr.unit_id
            and child.id = fr.scout_member_id
          where ma.unit_id = ur.unit_id and ma.profile_id = ur.profile_id
            and adult.active and adult.member_type = 'adult'
            and child.active and child.member_type = 'youth'
      )
    returning ur.unit_id, ur.profile_id
)
insert into public.audit_logs
    (unit_id, actor_profile_id, action, entity_type, entity_id, details)
select unit_id, null, 'role.revoked.parent', 'profile', profile_id,
       jsonb_build_object('reason','family_lifecycle_reconciliation')
from revoked;

commit;

select p.proname as function_name, p.prosecdef as security_definer,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute
from pg_catalog.pg_proc p
where p.oid in (
    'toolbox_private.lock_family_lifecycle(uuid)'::regprocedure,
    'public.set_toolbox_member_active(uuid,uuid,boolean)'::regprocedure,
    'public.set_toolbox_family_relationship(uuid,uuid,uuid,text)'::regprocedure,
    'public.remove_toolbox_family_relationship(uuid,uuid,uuid)'::regprocedure,
    'public.grant_toolbox_member_role(uuid,uuid,text)'::regprocedure,
    'public.review_toolbox_access(uuid,boolean,uuid,text)'::regprocedure
)
order by p.proname;
