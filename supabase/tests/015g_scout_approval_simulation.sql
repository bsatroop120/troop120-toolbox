-- 015G: Rollback-only simulation of administrator Scout account approval.
-- NOT a migration. Do not commit. Run the entire script as one query.
-- The real Scout gate remains unchanged after rollback.
begin;

-- Temporary prototype inside this transaction. Only synthetic identities
-- created below can qualify. Fictional consent is never production consent.
create function toolbox_private.test_scout_approval_eligible(
    p_unit_id uuid,p_member_id uuid,p_profile_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from auth.users u
        where u.id=p_profile_id and u.email_confirmed_at is not null
          and u.email like '%@example.invalid'
          and u.raw_app_meta_data->>'toolbox_test_scout'='true'
    )
    and exists (
        select 1 from public.members m
        where m.unit_id=p_unit_id and m.id=p_member_id
          and m.active and m.member_type='youth'
    )
    and coalesce((
        select e.decision='confirmed' and exists (
            select 1 from public.family_relationships fr
            join public.members a on a.unit_id=fr.unit_id and a.id=fr.adult_member_id
            where fr.unit_id=e.unit_id and fr.scout_member_id=e.scout_member_id
              and fr.adult_member_id=e.adult_member_id and a.active
        )
        from toolbox_private.scout_consent_events e
        where e.unit_id=p_unit_id and e.scout_member_id=p_member_id
        order by e.recorded_at desc,e.id desc limit 1
    ),false);
$$;
revoke all on function toolbox_private.test_scout_approval_eligible(uuid,uuid,uuid)
    from public,anon,authenticated;

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

    if p_role_code = 'scout' and not toolbox_private.test_scout_approval_eligible(p_unit_id,p_member_id,v_profile) then
        raise exception 'Test Scout approval eligibility required';
    end if;

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

        if p_assigned_role = 'scout' and not toolbox_private.test_scout_approval_eligible(v_request.unit_id,v_member.id,v_request.profile_id) then
            raise exception 'Test Scout approval eligibility required';
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

do $$
declare
    v_unit uuid;
    v_admin uuid;
    v_scout_user uuid := gen_random_uuid();
    v_other_user uuid := gen_random_uuid();
    v_id uuid;
begin
    select id into strict v_unit from public.units where slug='troop-120';
    select profile_id into strict v_admin from public.user_roles
    where unit_id=v_unit and role_code='admin';
    foreach v_id in array array[v_scout_user,v_other_user] loop
        insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,
            raw_app_meta_data,raw_user_meta_data)
        values(v_id,'authenticated','authenticated',v_id::text||'@example.invalid',
            now(),now(),now(),
            case when v_id=v_scout_user then '{"toolbox_test_scout":true}'::jsonb else '{}'::jsonb end,
            '{}'::jsonb);
    end loop;
    perform set_config('toolbox.test_unit',v_unit::text,true);
    perform set_config('toolbox.test_admin',v_admin::text,true);
    perform set_config('toolbox.test_scout_user',v_scout_user::text,true);
    perform set_config('toolbox.test_other_user',v_other_user::text,true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_user uuid := current_setting('toolbox.test_scout_user')::uuid;
    v_other uuid := current_setting('toolbox.test_other_user')::uuid;
    v_scout uuid;
    v_unrelated uuid;
    v_adult uuid;
    v_request uuid;
    v_other_request uuid;
    v_denied boolean;
begin
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
    v_request := public.request_toolbox_access('Fictional Scout Approval Test');

    perform set_config('request.jwt.claim.sub',v_other::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
    v_other_request := public.request_toolbox_access('Ordinary Test Applicant');

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    v_scout := public.create_toolbox_member(v_unit,'Fictional Approval Scout','youth');
    v_unrelated := public.create_toolbox_member(v_unit,'Fictional Unrelated Scout','youth');
    v_adult := public.create_toolbox_member(v_unit,'Fictional Guardian','adult');
    perform public.set_toolbox_family_relationship(v_unit,v_adult,v_scout,'guardian');

    v_denied:=false;
    begin
        perform public.review_toolbox_access(v_request,true,v_scout,'scout');
    exception when raise_exception then
        if sqlerrm <> 'Test Scout approval eligibility required' then raise; end if;
        v_denied:=true;
    end;
    if not v_denied then raise exception 'FAIL: approved without test consent'; end if;

    perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_adult,true);

    v_denied:=false;
    begin
        perform public.review_toolbox_access(v_other_request,true,v_scout,'scout');
    exception when raise_exception then
        if sqlerrm <> 'Test Scout approval eligibility required' then raise; end if;
        v_denied:=true;
    end;
    if not v_denied then raise exception 'FAIL: ordinary account passed test-only gate'; end if;

    perform public.review_toolbox_access(v_request,true,v_scout,'scout');

    if not exists(select 1 from public.access_requests
        where id=v_request and status='approved' and assigned_role='scout')
       or not exists(select 1 from public.member_accounts
        where unit_id=v_unit and profile_id=v_user and member_id=v_scout) then
        raise exception 'FAIL: approval or member linkage';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
    if (select count(*) from public.members) <> 1
       or not exists(select 1 from public.members where id=v_scout)
       or exists(select 1 from public.members where id in (v_unrelated,v_adult))
       or (select count(*) from public.user_roles) <> 1
       or not exists(select 1 from public.user_roles where role_code='scout')
       or exists(select 1 from public.family_relationships)
       or exists(select 1 from public.audit_logs) then
        raise exception 'FAIL: Scout record isolation';
    end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_adult,false);

    if exists(select 1 from public.user_roles where unit_id=v_unit and profile_id=v_user)
       or not exists(select 1 from public.audit_logs where unit_id=v_unit
          and entity_id=v_scout and action='role.revoked.scout'
          and details->>'reason'='test_consent_withdrawn') then
        raise exception 'FAIL: Scout role withdrawal or audit';
    end if;

    v_denied:=false;
    begin
        perform public.grant_toolbox_member_role(v_unit,v_scout,'scout');
    exception when raise_exception then
        if sqlerrm <> 'Test Scout approval eligibility required' then raise; end if;
        v_denied:=true;
    end;
    if not v_denied then raise exception 'FAIL: role restored after withdrawal'; end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
    if exists(select 1 from public.members) or exists(select 1 from public.units)
       or exists(select 1 from public.user_roles) then
        raise exception 'FAIL: withdrawn Scout still has access';
    end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_adult,true);
    if exists(select 1 from public.user_roles where unit_id=v_unit and profile_id=v_user) then
        raise exception 'FAIL: new consent automatically restored role';
    end if;
    perform public.grant_toolbox_member_role(v_unit,v_scout,'scout');

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
    if (select count(*) from public.members) <> 1
       or not exists(select 1 from public.members where id=v_scout) then
        raise exception 'FAIL: explicit Scout restoration or isolation';
    end if;
end;
$$;

reset role;
rollback;

-- Confirm rollback removed the prototype and restored the installed gates.
do $$
begin
    if to_regprocedure('toolbox_private.test_scout_approval_eligible(uuid,uuid,uuid)') is not null
       or position('Scout account assignment is not enabled pending consent safeguards' in
          pg_get_functiondef('public.review_toolbox_access(uuid,boolean,uuid,text)'::regprocedure))=0
       or position('Scout account assignment is not enabled pending consent safeguards' in
          pg_get_functiondef('public.grant_toolbox_member_role(uuid,uuid,text)'::regprocedure))=0 then
        raise exception 'FAIL: original Scout gates not restored';
    end if;
end;
$$;

select 'PASS: simulated Scout approval, record isolation, consent withdrawal, explicit restoration and original gates restored' as test_result;
