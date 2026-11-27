-- 014B: Family relationship authorization and parent access regression test.
-- Run the entire script in the development database. All writes roll back.
begin;

do $$
declare
    v_unit uuid;
    v_admin uuid;
    v_user uuid := gen_random_uuid();
    v_other_unit uuid;
    v_foreign_scout uuid;
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

    insert into public.members (unit_id,display_name,member_type)
    values (v_other_unit,'Fictional Foreign Scout','youth')
    returning id into v_foreign_scout;

    perform set_config('toolbox.test_unit',v_unit::text,true);
    perform set_config('toolbox.test_admin',v_admin::text,true);
    perform set_config('toolbox.test_user',v_user::text,true);
    perform set_config('toolbox.test_other_unit',v_other_unit::text,true);
    perform set_config('toolbox.test_foreign_scout',v_foreign_scout::text,true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_user uuid := current_setting('toolbox.test_user')::uuid;
    v_other_unit uuid := current_setting('toolbox.test_other_unit')::uuid;
    v_foreign_scout uuid := current_setting('toolbox.test_foreign_scout')::uuid;
    v_parent uuid;
    v_guardian uuid;
    v_child_a uuid;
    v_child_b uuid;
    v_unrelated uuid;
    v_request uuid;
    v_denied boolean;
    v_attempt integer;
begin
    if current_user <> 'authenticated' then
        raise exception 'FAIL: wrong database role';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);

    if auth.uid() is distinct from v_user then
        raise exception 'FAIL: applicant identity';
    end if;
    v_request := public.request_toolbox_access('Fictional Family Applicant');

    if not exists (
        select 1 from public.access_requests
        where id=v_request and status='pending'
          and requested_role is null and assigned_role is null
    ) or exists (select 1 from public.user_roles) then
        raise exception 'FAIL: role-neutral registration';
    end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);

    v_parent := public.create_toolbox_member(v_unit,'Fictional Parent','adult');
    v_guardian := public.create_toolbox_member(v_unit,'Fictional Guardian','adult');
    v_child_a := public.create_toolbox_member(v_unit,'Fictional Scout A','youth');
    v_child_b := public.create_toolbox_member(v_unit,'Fictional Scout B','youth');
    v_unrelated := public.create_toolbox_member(v_unit,'Fictional Unrelated Scout','youth');

    v_denied := false;
    begin
        perform public.review_toolbox_access(v_request,true,v_parent,'parent');
    exception when raise_exception then
        if sqlerrm <> 'Verified family relationship required' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: parent approved without relationship'; end if;

    -- Invalid unit, member type, and relationship type must be rejected.
    for v_attempt in 1..4 loop
        v_denied := false;
        begin
            case v_attempt
                when 1 then perform public.set_toolbox_family_relationship(v_other_unit,v_parent,v_foreign_scout,'parent');
                when 2 then perform public.set_toolbox_family_relationship(v_unit,v_parent,v_foreign_scout,'parent');
                when 3 then perform public.set_toolbox_family_relationship(v_unit,v_child_a,v_child_b,'parent');
                when 4 then perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_a,'invalid');
            end case;
        exception when raise_exception then
            if sqlerrm not in ('Administrator access required',
                'Select an active adult in this unit','Select an active Scout in this unit',
                'Invalid relationship type') then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: invalid relationship %',v_attempt; end if;
    end loop;

    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_a,'parent');
    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_b,'parent');
    perform public.set_toolbox_family_relationship(v_unit,v_guardian,v_child_a,'guardian');
    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_b,'guardian');
    -- Repeating an identical relationship must be harmless.
    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_child_b,'guardian');

    if (select count(*) from public.family_relationships
        where unit_id=v_unit and adult_member_id=v_parent) <> 2
       or (select count(*) from public.family_relationships
        where unit_id=v_unit and scout_member_id=v_child_a
          and adult_member_id in (v_parent,v_guardian)) <> 2
       or not exists (select 1 from public.family_relationships
        where unit_id=v_unit and adult_member_id=v_parent
          and scout_member_id=v_child_b and relationship_type='guardian')
       or exists (select 1 from public.user_roles where profile_id=v_user) then
        raise exception 'FAIL: family links, relationship update or automatic role grant';
    end if;

    perform public.review_toolbox_access(v_request,true,v_parent,'parent');

    if not exists (select 1 from public.access_requests
        where id=v_request and status='approved' and assigned_role='parent'
          and reviewed_by=v_admin) then
        raise exception 'FAIL: administrator-selected parent approval';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);

    if (select count(*) from public.members) <> 3
       or not exists (select 1 from public.members where id=v_parent)
       or not exists (select 1 from public.members where id=v_child_a)
       or not exists (select 1 from public.members where id=v_child_b)
       or exists (select 1 from public.members where id in (v_unrelated,v_guardian,v_foreign_scout))
       or (select count(*) from public.family_relationships) <> 2 then
        raise exception 'FAIL: parent record isolation';
    end if;

    -- A parent cannot add or remove their own family links.
    for v_attempt in 1..2 loop
        v_denied := false;
        begin
            case v_attempt
                when 1 then perform public.set_toolbox_family_relationship(v_unit,v_parent,v_unrelated,'parent');
                when 2 then perform public.remove_toolbox_family_relationship(v_unit,v_parent,v_child_a);
            end case;
        exception when raise_exception then
            if sqlerrm <> 'Administrator access required' then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: parent can manage family links'; end if;
    end loop;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);

    perform public.remove_toolbox_family_relationship(v_unit,v_parent,v_child_a);

    if not exists (select 1 from public.user_roles
        where profile_id=v_user and unit_id=v_unit and role_code='parent')
       or not exists (select 1 from public.family_relationships
        where adult_member_id=v_guardian and scout_member_id=v_child_a) then
        raise exception 'FAIL: removal affected other valid relationships or roles';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);
    if exists (select 1 from public.members where id=v_child_a)
       or not exists (select 1 from public.members where id=v_child_b) then
        raise exception 'FAIL: removed child remains accessible or remaining child hidden';
    end if;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_admin,'role','authenticated')::text,true);

    -- Independently assigned leader role must survive removal of last family link.
    perform public.grant_toolbox_member_role(v_unit,v_parent,'leader');
    perform public.remove_toolbox_family_relationship(v_unit,v_parent,v_child_b);

    if exists (select 1 from public.user_roles
        where profile_id=v_user and unit_id=v_unit and role_code='parent')
       or not exists (select 1 from public.user_roles
        where profile_id=v_user and unit_id=v_unit and role_code='leader') then
        raise exception 'FAIL: last family link did not revoke only parent role';
    end if;

    perform public.revoke_toolbox_member_role(v_unit,v_parent,'leader');

    if (select count(*) from public.audit_logs
        where entity_id=v_parent and actor_profile_id=v_admin
          and action='family.linked') <> 2
       or (select count(*) from public.audit_logs
        where entity_id=v_parent and actor_profile_id=v_admin
          and action='family.updated'
          and details->>'relationship_type'='guardian') <> 1
       or (select count(*) from public.audit_logs
        where entity_id=v_parent and actor_profile_id=v_admin
          and action='family.unlinked') <> 2
       or not exists (select 1 from public.audit_logs
        where entity_id=v_parent and actor_profile_id=v_admin
          and action='role.revoked.parent'
          and details->>'reason'='no_active_linked_scout') then
        raise exception 'FAIL: family audit entries';
    end if;

    perform set_config('request.jwt.claim.sub',v_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object(
        'sub',v_user,'role','authenticated')::text,true);

    if exists (select 1 from public.members)
       or exists (select 1 from public.units)
       or exists (select 1 from public.family_relationships)
       or exists (select 1 from public.user_roles) then
        raise exception 'FAIL: revoked account retains access';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: family management, parent isolation, role revocation and audit logging' as test_result;
