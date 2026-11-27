-- 010D: Family-level RLS and successful administrator approval tests.
-- Run the ENTIRE script in the SQL Editor as the database operator.
-- All fixtures are fictional and all changes are rolled back.
begin;

do $$
declare
    v_unit uuid;
    v_other_unit uuid;
    v_admin uuid;
    v_parent_user uuid := gen_random_uuid();
    v_scout_user uuid := gen_random_uuid();
    v_parent uuid;
    v_unlinked_adult uuid;
    v_child uuid;
    v_other_child uuid;
    v_foreign_child uuid;
    v_patrol uuid;
    v_other_patrol uuid;
begin
    select id into strict v_unit from public.units
    where slug = 'troop-120';
    select profile_id into strict v_admin from public.user_roles
    where unit_id = v_unit and role_code = 'admin';

    -- Temporary, non-login test identities. No passwords or real emails.
    insert into auth.users (
        id, aud, role, email, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
    ) values
        (v_parent_user, 'authenticated', 'authenticated',
         v_parent_user::text || '@example.invalid', now(),
         now(), now(), '{}'::jsonb, '{}'::jsonb),
        (v_scout_user, 'authenticated', 'authenticated',
         v_scout_user::text || '@example.invalid', now(),
         now(), now(), '{}'::jsonb, '{}'::jsonb);

    insert into public.units (name, slug)
    values ('Fictional Test Unit', 'test-' || gen_random_uuid()::text)
    returning id into v_other_unit;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Parent', 'adult')
    returning id into v_parent;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Unlinked Adult', 'adult')
    returning id into v_unlinked_adult;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Scout A', 'youth')
    returning id into v_child;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Scout B', 'youth')
    returning id into v_other_child;

    insert into public.members (unit_id, display_name, member_type)
    values (v_other_unit, 'Fictional Other Unit Scout', 'youth')
    returning id into v_foreign_child;

    insert into public.family_relationships (
        unit_id, adult_member_id, scout_member_id, relationship_type
    ) values (v_unit, v_parent, v_child, 'parent');

    insert into public.patrols (unit_id, name)
    values (v_unit, 'Test Patrol ' || gen_random_uuid()::text)
    returning id into v_patrol;

    insert into public.patrols (unit_id, name)
    values (v_unit, 'Test Patrol ' || gen_random_uuid()::text)
    returning id into v_other_patrol;

    insert into public.patrol_members (unit_id, patrol_id, member_id)
    values (v_unit, v_patrol, v_child),
           (v_unit, v_other_patrol, v_other_child);

    perform set_config('toolbox.test_admin', v_admin::text, true);
    perform set_config('toolbox.test_parent_user', v_parent_user::text, true);
    perform set_config('toolbox.test_scout_user', v_scout_user::text, true);
    perform set_config('toolbox.test_parent', v_parent::text, true);
    perform set_config('toolbox.test_unlinked_adult', v_unlinked_adult::text, true);
    perform set_config('toolbox.test_child', v_child::text, true);
    perform set_config('toolbox.test_other_child', v_other_child::text, true);
    perform set_config('toolbox.test_foreign_child', v_foreign_child::text, true);
    perform set_config('toolbox.test_patrol', v_patrol::text, true);
end;
$$;

set local role authenticated;

do $$
declare
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_parent_user uuid := current_setting('toolbox.test_parent_user')::uuid;
    v_scout_user uuid := current_setting('toolbox.test_scout_user')::uuid;
    v_parent uuid := current_setting('toolbox.test_parent')::uuid;
    v_unlinked_adult uuid := current_setting('toolbox.test_unlinked_adult')::uuid;
    v_child uuid := current_setting('toolbox.test_child')::uuid;
    v_other_child uuid := current_setting('toolbox.test_other_child')::uuid;
    v_foreign_child uuid := current_setting('toolbox.test_foreign_child')::uuid;
    v_patrol uuid := current_setting('toolbox.test_patrol')::uuid;
    v_parent_request uuid;
    v_scout_request uuid;
    v_denied boolean := false;
begin
    if current_user <> 'authenticated' then
        raise exception 'FAIL: wrong database role';
    end if;

    -- Parent submits a request.
    perform set_config('request.jwt.claim.sub', v_parent_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_parent_user, 'role', 'authenticated')::text, true);
    if auth.uid() is distinct from v_parent_user then
        raise exception 'FAIL: parent test identity';
    end if;

    v_parent_request := public.request_toolbox_access('Test Parent', 'parent');
    if exists (select 1 from public.members) then
        raise exception 'FAIL: pending parent sees members';
    end if;

    -- Scout submits a separate request.
    perform set_config('request.jwt.claim.sub', v_scout_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_scout_user, 'role', 'authenticated')::text, true);
    v_scout_request := public.request_toolbox_access('Test Scout', 'scout');

    if exists (select 1 from public.access_requests where id = v_parent_request) then
        raise exception 'FAIL: Scout sees another account request';
    end if;

    -- Administrator checks scope and reviews both requests.
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_admin, 'role', 'authenticated')::text, true);

    if not exists (select 1 from public.members where id = v_other_child)
       or exists (select 1 from public.members where id = v_foreign_child) then
        raise exception 'FAIL: administrator unit isolation';
    end if;

    begin
        perform public.review_toolbox_access(v_parent_request, true, v_unlinked_adult);
    exception when raise_exception then
        if sqlerrm <> 'Verified family relationship required' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then
        raise exception 'FAIL: approved parent without family relationship';
    end if;

    perform public.review_toolbox_access(v_parent_request, true, v_parent);
    perform public.review_toolbox_access(v_scout_request, true, v_child);

    if (select count(*) from public.access_requests
        where id in (v_parent_request, v_scout_request)
          and status = 'approved' and reviewed_by = v_admin) <> 2
       or (select count(*) from public.audit_logs
           where entity_id in (v_parent_request, v_scout_request)
             and action = 'access.approved') <> 2 then
        raise exception 'FAIL: approval status or audit log';
    end if;

    -- Approved parent: own record and linked child only.
    perform set_config('request.jwt.claim.sub', v_parent_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_parent_user, 'role', 'authenticated')::text, true);

    if (select count(*) from public.members) <> 2
       or not exists (select 1 from public.members where id = v_parent)
       or not exists (select 1 from public.members where id = v_child)
       or (select count(*) from public.patrol_members) <> 1
       or (select count(*) from public.patrols) <> 1
       or not exists (select 1 from public.patrols where id = v_patrol)
       or (select count(*) from public.family_relationships) <> 1
       or (select count(*) from public.member_accounts) <> 1
       or exists (select 1 from public.audit_logs)
       or exists (select 1 from public.user_roles where role_code <> 'parent')
       or not exists (select 1 from public.user_roles where role_code = 'parent') then
        raise exception 'FAIL: parent record, role or patrol isolation';
    end if;

    -- Approved Scout: own member record and patrol only.
    perform set_config('request.jwt.claim.sub', v_scout_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_scout_user, 'role', 'authenticated')::text, true);

    if (select count(*) from public.members) <> 1
       or not exists (select 1 from public.members where id = v_child)
       or (select count(*) from public.patrol_members) <> 1
       or (select count(*) from public.patrols) <> 1
       or not exists (select 1 from public.patrols where id = v_patrol)
       or exists (select 1 from public.family_relationships)
       or exists (select 1 from public.audit_logs)
       or exists (select 1 from public.user_roles where role_code <> 'scout')
       or not exists (select 1 from public.user_roles where role_code = 'scout') then
        raise exception 'FAIL: Scout record, role or patrol isolation';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: parent and Scout isolation, unit isolation, successful approvals and audit logging' as test_result;
