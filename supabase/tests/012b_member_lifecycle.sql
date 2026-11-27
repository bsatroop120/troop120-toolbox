-- 012B: Functional tests for administrator member lifecycle RPCs.
-- Run the entire script in the development SQL Editor. All writes roll back.
begin;

do $$
declare
    v_unit uuid;
    v_admin uuid;
    v_user uuid := gen_random_uuid();
    v_other_unit uuid;
    v_other_member uuid;
begin
    select id into strict v_unit from public.units where slug = 'troop-120';
    select profile_id into strict v_admin from public.user_roles
    where unit_id = v_unit and role_code = 'admin';

    insert into auth.users (
        id, aud, role, email, email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data
    ) values (
        v_user, 'authenticated', 'authenticated',
        v_user::text || '@example.invalid', now(), now(), now(),
        '{}'::jsonb, '{}'::jsonb
    );

    insert into public.units (name, slug)
    values ('Fictional Other Unit', 'test-' || gen_random_uuid()::text)
    returning id into v_other_unit;

    insert into public.members (unit_id, display_name, member_type)
    values (v_other_unit, 'Fictional Other Member', 'adult')
    returning id into v_other_member;

    perform set_config('toolbox.test_unit', v_unit::text, true);
    perform set_config('toolbox.test_admin', v_admin::text, true);
    perform set_config('toolbox.test_user', v_user::text, true);
    perform set_config('toolbox.test_other_unit', v_other_unit::text, true);
    perform set_config('toolbox.test_other_member', v_other_member::text, true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_user uuid := current_setting('toolbox.test_user')::uuid;
    v_other_unit uuid := current_setting('toolbox.test_other_unit')::uuid;
    v_other_member uuid := current_setting('toolbox.test_other_member')::uuid;
    v_member uuid;
    v_admin_member uuid;
    v_request uuid;
    v_attempt integer;
    v_denied boolean;
begin
    if current_user <> 'authenticated' then
        raise exception 'FAIL: wrong database role';
    end if;

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_user, 'role', 'authenticated')::text, true);
    if auth.uid() is distinct from v_user then
        raise exception 'FAIL: applicant identity';
    end if;
    v_request := public.request_toolbox_access('Lifecycle Test Applicant','leader');

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_admin, 'role', 'authenticated')::text, true);

    v_member := public.create_toolbox_member(v_unit, 'Lifecycle Test Adult', 'adult');

    if not exists (
        select 1 from public.list_toolbox_access_requests(v_unit) r
        where r.request_id = v_request and r.email_verified
          and r.request_status = 'pending'
    ) then
        raise exception 'FAIL: administrator applicant lookup';
    end if;

    perform public.review_toolbox_access(v_request,true,v_member);
    perform public.update_toolbox_member_name(v_unit,v_member,'Lifecycle Test Renamed');

    if not exists (
        select 1 from public.members where id = v_member
        and display_name = 'Lifecycle Test Renamed'
    ) then
        raise exception 'FAIL: member rename';
    end if;

    select member_id into strict v_admin_member from public.member_accounts
    where unit_id = v_unit and profile_id = v_admin;

    -- Reject cross-unit changes and protect the administrator.
    for v_attempt in 1..3 loop
        v_denied := false;
        begin
            case v_attempt
                when 1 then perform public.update_toolbox_member_name(v_other_unit,v_other_member,'Forbidden');
                when 2 then perform public.set_toolbox_member_active(v_unit,v_admin_member,false);
                when 3 then perform public.revoke_toolbox_member_role(v_unit,v_admin_member,'leader');
            end case;
        exception when raise_exception then
            if sqlerrm not in (
                'Administrator access required', 'Administrator membership is protected',
                'Administrator account is protected'
            ) then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: protected action %', v_attempt; end if;
    end loop;

    -- Approved leader must not be able to call administrator RPCs.
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_user, 'role', 'authenticated')::text, true);

    if not exists (select 1 from public.members where id = v_member) then
        raise exception 'FAIL: approved leader cannot read roster';
    end if;

    for v_attempt in 1..5 loop
        v_denied := false;
        begin
            case v_attempt
                when 1 then perform public.create_toolbox_member(v_unit,'Forbidden','adult');
                when 2 then perform public.list_toolbox_access_requests(v_unit);
                when 3 then perform public.update_toolbox_member_name(v_unit,v_member,'Forbidden');
                when 4 then perform public.set_toolbox_member_active(v_unit,v_member,false);
                when 5 then perform public.revoke_toolbox_member_role(v_unit,v_member,'leader');
            end case;
        exception when raise_exception then
            if sqlerrm <> 'Administrator access required' then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: leader called admin function %', v_attempt; end if;
    end loop;

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_admin, 'role', 'authenticated')::text, true);
    perform public.revoke_toolbox_member_role(v_unit,v_member,'leader');

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_user, 'role', 'authenticated')::text, true);
    if exists (select 1 from public.user_roles)
       or exists (select 1 from public.units)
       or exists (select 1 from public.members)
       or exists (select 1 from public.settings) then
        raise exception 'FAIL: revoked user retains troop access';
    end if;

    -- Reapproval must be explicit; use the existing account/member link.
    v_request := public.request_toolbox_access('Lifecycle Test Applicant','leader');
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_admin, 'role', 'authenticated')::text, true);
    perform public.review_toolbox_access(v_request,true,v_member);
    perform public.set_toolbox_member_active(v_unit,v_member,false);

    if not exists (select 1 from public.members where id = v_member and not active)
       or exists (select 1 from public.user_roles where profile_id = v_user and unit_id = v_unit)
       or not exists (select 1 from public.member_accounts where member_id = v_member and profile_id = v_user) then
        raise exception 'FAIL: deactivation did not remove roles or preserve link';
    end if;

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_user, 'role', 'authenticated')::text, true);
    if exists (select 1 from public.members) or exists (select 1 from public.units) then
        raise exception 'FAIL: deactivated user retains troop access';
    end if;
    v_request := public.request_toolbox_access('Lifecycle Test Applicant','leader');

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_admin, 'role', 'authenticated')::text, true);

    v_denied := false;
    begin
        perform public.review_toolbox_access(v_request,true,v_member);
    exception when raise_exception then
        if sqlerrm <> 'Select an active member in this unit' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: approved inactive member'; end if;

    perform public.set_toolbox_member_active(v_unit,v_member,true);
    if not exists (select 1 from public.members where id = v_member and active)
       or exists (select 1 from public.user_roles where profile_id = v_user and unit_id = v_unit) then
        raise exception 'FAIL: reactivation restored roles automatically';
    end if;

    if (select count(distinct action) from public.audit_logs
        where entity_id = v_member and actor_profile_id = v_admin
          and action in ('member.created','member.name_updated','role.revoked.leader',
                         'member.deactivated','member.reactivated')) <> 5 then
        raise exception 'FAIL: lifecycle audit entries';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: member lifecycle, administrator protections, role revocation, reactivation and audit logging' as test_result;
