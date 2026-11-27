-- 010E: Adult leader access, unit isolation and deactivation.
-- Run the entire script in the SQL Editor as database administrator.
-- All fictional fixtures and test writes are rolled back.
begin;

do $$
declare
    v_unit uuid;
    v_other_unit uuid;
    v_user uuid := gen_random_uuid();
    v_applicant uuid := gen_random_uuid();
    v_leader uuid;
    v_scout uuid;
    v_parent uuid;
    v_foreign uuid;
    v_patrol uuid;
    v_foreign_patrol uuid;
    v_request uuid;
begin
    select id into strict v_unit from public.units
    where slug = 'troop-120';

    insert into auth.users (
        id, aud, role, email, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
    )
    values
        (v_user, 'authenticated', 'authenticated',
         v_user::text || '@example.invalid', now(),
         now(), now(), '{}'::jsonb, '{}'::jsonb),
        (v_applicant, 'authenticated', 'authenticated',
         v_applicant::text || '@example.invalid', now(),
         now(), now(), '{}'::jsonb, '{}'::jsonb);

    insert into public.profiles (id, display_name)
    values (v_user, 'Test Leader'), (v_applicant, 'Test Applicant');

    insert into public.units (name, slug)
    values ('Fictional Other Unit', 'test-' || gen_random_uuid()::text)
    returning id into v_other_unit;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Leader', 'adult') returning id into v_leader;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Scout', 'youth') returning id into v_scout;

    insert into public.members (unit_id, display_name, member_type)
    values (v_unit, 'Fictional Parent', 'adult') returning id into v_parent;

    insert into public.members (unit_id, display_name, member_type)
    values (v_other_unit, 'Fictional Other Unit Scout', 'youth')
    returning id into v_foreign;

    insert into public.member_accounts (profile_id, unit_id, member_id)
    values (v_user, v_unit, v_leader);

    insert into public.user_roles (profile_id, unit_id, role_code)
    values (v_user, v_unit, 'leader');

    insert into public.family_relationships (
        unit_id, adult_member_id, scout_member_id, relationship_type
    ) values (v_unit, v_parent, v_scout, 'parent');

    insert into public.patrols (unit_id, name)
    values (v_unit, 'Test Patrol ' || gen_random_uuid()::text)
    returning id into v_patrol;

    insert into public.patrols (unit_id, name)
    values (v_other_unit, 'Test Patrol ' || gen_random_uuid()::text)
    returning id into v_foreign_patrol;

    insert into public.patrol_members (unit_id, patrol_id, member_id)
    values (v_unit, v_patrol, v_scout),
           (v_other_unit, v_foreign_patrol, v_foreign);

    insert into public.access_requests (profile_id, unit_id, requested_role)
    values (v_applicant, v_unit, 'parent') returning id into v_request;

    insert into public.audit_logs (unit_id, action, entity_type, entity_id)
    values (v_unit, 'access.requested', 'access_request', v_request);

    perform set_config('toolbox.test_leader', v_leader::text, true);
    perform set_config('toolbox.test_leader_unit', v_unit::text, true);
    perform set_config('toolbox.test_other_unit', v_other_unit::text, true);
    perform set_config('toolbox.test_scout', v_scout::text, true);
    perform set_config('toolbox.test_foreign', v_foreign::text, true);
    perform set_config('toolbox.test_patrol', v_patrol::text, true);
    perform set_config('toolbox.test_foreign_patrol', v_foreign_patrol::text, true);
    perform set_config('toolbox.test_applicant', v_applicant::text, true);
    perform set_config('toolbox.test_request', v_request::text, true);
    perform set_config('toolbox.test_user', v_user::text, true);
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_user, 'role', 'authenticated')::text, true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_leader_unit')::uuid;
    v_other_unit uuid := current_setting('toolbox.test_other_unit')::uuid;
    v_scout uuid := current_setting('toolbox.test_scout')::uuid;
    v_foreign uuid := current_setting('toolbox.test_foreign')::uuid;
    v_patrol uuid := current_setting('toolbox.test_patrol')::uuid;
    v_foreign_patrol uuid := current_setting('toolbox.test_foreign_patrol')::uuid;
    v_applicant uuid := current_setting('toolbox.test_applicant')::uuid;
    v_request uuid := current_setting('toolbox.test_request')::uuid;
    v_denied boolean := false;
begin
    if current_user <> 'authenticated'
       or auth.uid() is distinct from current_setting('toolbox.test_user')::uuid then
        raise exception 'FAIL: test identity';
    end if;

    if not exists (select 1 from public.units where id = v_unit)
       or not exists (select 1 from public.members where id = v_scout)
       or not exists (select 1 from public.patrols where id = v_patrol)
       or not exists (select 1 from public.patrol_members where member_id = v_scout)
       or exists (select 1 from public.units where id = v_other_unit)
       or exists (select 1 from public.members where id = v_foreign)
       or exists (select 1 from public.patrols where id = v_foreign_patrol)
       or exists (select 1 from public.patrol_members where member_id = v_foreign) then
        raise exception 'FAIL: leader roster or unit isolation';
    end if;

    if exists (select 1 from public.family_relationships)
       or exists (select 1 from public.audit_logs)
       or exists (select 1 from public.access_requests where id = v_request)
       or exists (select 1 from public.profiles where id = v_applicant)
       or exists (select 1 from public.member_accounts where profile_id <> auth.uid())
       or exists (select 1 from public.user_roles where role_code <> 'leader')
       or not exists (select 1 from public.user_roles where role_code = 'leader') then
        raise exception 'FAIL: leader sees administrator-only information';
    end if;

    begin
        perform public.review_toolbox_access(v_request, true, null);
    exception when raise_exception then
        if sqlerrm <> 'Request unavailable or access denied' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then
        raise exception 'FAIL: leader could review request';
    end if;

    if exists (
        select 1 from pg_catalog.pg_tables t
        where t.schemaname = 'public'
          and t.tablename in (
            'units','profiles','members','roles','user_roles',
            'member_accounts','family_relationships','patrols',
            'patrol_members','access_requests','audit_logs','settings'
          )
          and has_table_privilege(current_user,
            format('%I.%I', t.schemaname, t.tablename),
            'INSERT, UPDATE, DELETE, TRUNCATE')
    ) then
        raise exception 'FAIL: direct client write privilege';
    end if;
end;
$$;

reset role;

-- Deactivate the fictional leader without removing their role.
update public.members set active = false
where id = current_setting('toolbox.test_leader')::uuid;

set local role authenticated;

do $$
begin
    if exists (select 1 from public.members)
       or exists (select 1 from public.patrols)
       or exists (select 1 from public.patrol_members)
       or exists (select 1 from public.member_accounts)
       or exists (select 1 from public.audit_logs) then
        raise exception 'FAIL: inactive leader retains roster access';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: leader permissions, cross-unit isolation, administrative restrictions and inactive-member roster denial' as test_result;
