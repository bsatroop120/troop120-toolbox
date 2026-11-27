-- 014E2: Parent lifecycle safeguards and Scout consent gate.
-- Development database only. Run the entire script; fixtures are rolled back.
begin;

do $$
declare
    v_unit uuid;
    v_admin uuid;
    v_user uuid := gen_random_uuid();
    v_second uuid := gen_random_uuid();
    v_id uuid;
begin
    select id into strict v_unit from public.units where slug = 'troop-120';
    select profile_id into strict v_admin from public.user_roles
    where unit_id = v_unit and role_code = 'admin';

    foreach v_id in array array[v_user,v_second] loop
        insert into auth.users (
            id,aud,role,email,email_confirmed_at,created_at,updated_at,
            raw_app_meta_data,raw_user_meta_data
        ) values (
            v_id,'authenticated','authenticated',
            v_id::text || '@example.invalid',now(),now(),now(),
            '{}'::jsonb,'{}'::jsonb
        );
    end loop;

    perform set_config('toolbox.test_unit',v_unit::text,true);
    perform set_config('toolbox.test_admin',v_admin::text,true);
    perform set_config('toolbox.test_user',v_user::text,true);
    perform set_config('toolbox.test_second',v_second::text,true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_user uuid := current_setting('toolbox.test_user')::uuid;
    v_second uuid := current_setting('toolbox.test_second')::uuid;
    v_parent uuid;
    v_guardian uuid;
    v_child_a uuid;
    v_child_b uuid;
    v_unrelated uuid;
    v_request uuid;
    v_second_request uuid;
    v_denied boolean;
begin
    if current_user <> 'authenticated' then
        raise exception 'FAIL: wrong database role';
    end if;
    if has_function_privilege('authenticated',
        'toolbox_private.lock_family_lifecycle(uuid)','EXECUTE')
       or has_function_privilege('anon',
        'toolbox_private.lock_family_lifecycle(uuid)','EXECUTE') then
        raise exception 'FAIL: internal lock helper exposed';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);
    if auth.uid() is distinct from v_user then raise exception 'FAIL: test identity'; end if;
    v_request := public.request_toolbox_access('Lifecycle Parent Test');

    perform set_config('request.jwt.claim.sub',v_second::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_second,'role','authenticated')::text,true);
    v_second_request := public.request_toolbox_access('Lifecycle Guardian Test');

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);
    v_parent := public.create_toolbox_member(v_unit,'Lifecycle Parent','adult');
    v_guardian := public.create_toolbox_member(v_unit,'Lifecycle Guardian','adult');
    v_child_a := public.create_toolbox_member(v_unit,'Lifecycle Scout A','youth');
    v_child_b := public.create_toolbox_member(v_unit,'Lifecycle Scout B','youth');
    v_unrelated := public.create_toolbox_member(v_unit,'Lifecycle Unrelated Scout','youth');

    -- The consent gate must exist on the backend, not just in the UI.
    v_denied := false;
    begin
        perform public.review_toolbox_access(v_second_request,true,v_child_a,'scout');
    exception when raise_exception then
        if sqlerrm <> 'Scout account assignment is not enabled pending consent safeguards' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: Scout approval gate'; end if;

    v_denied := false;
    begin
        perform public.grant_toolbox_member_role(v_unit,v_child_a,'scout');
    exception when raise_exception then
        if sqlerrm <> 'Scout account assignment is not enabled pending consent safeguards' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: direct Scout role gate'; end if;

    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_a,'parent');
    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_b,'parent');
    perform public.set_toolbox_family_relationship(v_unit,v_guardian,v_child_b,'guardian');
    perform public.review_toolbox_access(v_request,true,v_parent,'parent');
    perform public.review_toolbox_access(v_second_request,true,v_guardian,'parent');

    -- First deactivation: the parent retains access to the other active child.
    perform public.set_toolbox_member_active(v_unit,v_child_a,false);
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);
    if not exists (select 1 from public.user_roles where role_code='parent')
       or exists (select 1 from public.members where id in (v_child_a,v_unrelated,v_guardian))
       or not exists (select 1 from public.members where id=v_child_b)
       or (select count(*) from public.members) <> 2 then
        raise exception 'FAIL: partial deactivation isolation';
    end if;

    v_denied := false;
    begin
        perform public.set_toolbox_member_active(v_unit,v_child_b,false);
    exception when raise_exception then
        if sqlerrm <> 'Administrator access required' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: parent can deactivate Scout'; end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);
    -- Give the guardian an independent Leader role before deactivating the last Scout.
    perform public.grant_toolbox_member_role(v_unit,v_guardian,'leader');
    perform public.set_toolbox_member_active(v_unit,v_child_b,false);

    if exists (select 1 from public.user_roles
        where unit_id=v_unit and profile_id in (v_user,v_second) and role_code='parent')
       or not exists (select 1 from public.user_roles
        where unit_id=v_unit and profile_id=v_second and role_code='leader')
       or (select count(*) from public.family_relationships
        where unit_id=v_unit and adult_member_id in (v_parent,v_guardian)) <> 3
       or (select count(*) from public.audit_logs
        where unit_id=v_unit and entity_id in (v_parent,v_guardian)
          and actor_profile_id=v_admin and action='role.revoked.parent'
          and details->>'reason'='no_active_linked_scout'
          and details->>'scout_member_id'=v_child_b::text) <> 2 then
        raise exception 'FAIL: last Scout deactivation, role preservation, family history or audit';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);
    if exists (select 1 from public.members)
       or exists (select 1 from public.units)
       or exists (select 1 from public.settings)
       or exists (select 1 from public.family_relationships)
       or exists (select 1 from public.user_roles) then
        raise exception 'FAIL: parent-only account retains access';
    end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);

    v_denied := false;
    begin
        perform public.grant_toolbox_member_role(v_unit,v_parent,'parent');
    exception when raise_exception then
        if sqlerrm <> 'Verified family relationship required' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: parent grant with only inactive Scouts'; end if;

    perform public.set_toolbox_member_active(v_unit,v_child_b,true);
    if exists (select 1 from public.user_roles
        where unit_id=v_unit and profile_id in (v_user,v_second) and role_code='parent') then
        raise exception 'FAIL: Scout reactivation restored Parent role automatically';
    end if;

    perform public.grant_toolbox_member_role(v_unit,v_parent,'parent');
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);
    if not exists (select 1 from public.user_roles where role_code='parent')
       or (select count(*) from public.members) <> 2
       or not exists (select 1 from public.members where id=v_child_b)
       or exists (select 1 from public.members where id in (v_child_a,v_unrelated)) then
        raise exception 'FAIL: explicit parent restoration or isolation';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: parent lifecycle, multiple guardians, explicit restoration, audit and Scout consent gate' as test_result;
