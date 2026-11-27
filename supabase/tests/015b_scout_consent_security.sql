-- 015B: Development-only Scout consent authorization and history tests.
-- Run entire script. All fictional records and changes are rolled back.
begin;

do $$
declare
    v_unit uuid;
    v_admin uuid;
    v_parent_user uuid := gen_random_uuid();
    v_leader_user uuid := gen_random_uuid();
    v_scout_user uuid := gen_random_uuid();
    v_id uuid;
    v_other_unit uuid;
    v_foreign_scout uuid;
begin
    select id into strict v_unit from public.units where slug='troop-120';
    select profile_id into strict v_admin from public.user_roles
    where unit_id=v_unit and role_code='admin';

    foreach v_id in array array[v_parent_user,v_leader_user,v_scout_user] loop
        insert into auth.users (
            id,aud,role,email,email_confirmed_at,created_at,updated_at,
            raw_app_meta_data,raw_user_meta_data
        ) values (
            v_id,'authenticated','authenticated',
            v_id::text || '@example.invalid',now(),now(),now(),
            '{}'::jsonb,'{}'::jsonb
        );
    end loop;
    insert into public.units(name,slug)
    values ('Consent Test Other Unit','test-'||gen_random_uuid()::text)
    returning id into v_other_unit;
    insert into public.members(unit_id,display_name,member_type)
    values (v_other_unit,'Consent Test Foreign Scout','youth')
    returning id into v_foreign_scout;

    perform set_config('toolbox.test_unit',v_unit::text,true);
    perform set_config('toolbox.test_admin',v_admin::text,true);
    perform set_config('toolbox.test_parent_user',v_parent_user::text,true);
    perform set_config('toolbox.test_leader_user',v_leader_user::text,true);
    perform set_config('toolbox.test_scout_user',v_scout_user::text,true);
    perform set_config('toolbox.test_foreign_scout',v_foreign_scout::text,true);
end;
$$;

set local role authenticated;

do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
    v_parent_user uuid := current_setting('toolbox.test_parent_user')::uuid;
    v_leader_user uuid := current_setting('toolbox.test_leader_user')::uuid;
    v_scout_user uuid := current_setting('toolbox.test_scout_user')::uuid;
    v_foreign_scout uuid := current_setting('toolbox.test_foreign_scout')::uuid;
    v_parent uuid;
    v_leader uuid;
    v_scout uuid;
    v_parent_request uuid;
    v_leader_request uuid;
    v_scout_request uuid;
    v_event uuid;
    v_id uuid;
    v_denied boolean;
    v_attempt int;
begin
    if current_user <> 'authenticated' then raise exception 'FAIL: wrong database role'; end if;
    if has_table_privilege('authenticated','toolbox_private.scout_consent_events',
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('anon','toolbox_private.scout_consent_events',
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_function_privilege('anon',
            'public.record_toolbox_test_scout_consent(uuid,uuid,uuid,boolean)','EXECUTE') then
        raise exception 'FAIL: consent grants';
    end if;

    perform set_config('request.jwt.claim.sub',v_parent_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_parent_user,'role','authenticated')::text,true);
    if auth.uid() is distinct from v_parent_user then raise exception 'FAIL: test identity'; end if;
    v_parent_request := public.request_toolbox_access('Consent Test Parent');

    perform set_config('request.jwt.claim.sub',v_leader_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_leader_user,'role','authenticated')::text,true);
    v_leader_request := public.request_toolbox_access('Consent Test Leader');

    perform set_config('request.jwt.claim.sub',v_scout_user::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_scout_user,'role','authenticated')::text,true);
    v_scout_request := public.request_toolbox_access('Consent Test Scout');

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    v_parent := public.create_toolbox_member(v_unit,'Consent Test Parent','adult');
    v_leader := public.create_toolbox_member(v_unit,'Consent Test Leader','adult');
    v_scout := public.create_toolbox_member(v_unit,'Consent Test Scout','youth');

    -- Invalid consent inputs must not create events.
    for v_attempt in 1..5 loop
        v_denied := false;
        begin
            case v_attempt
                when 1 then perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,true);
                when 2 then perform public.record_toolbox_test_scout_consent(v_unit,v_foreign_scout,v_parent,true);
                when 3 then perform public.record_toolbox_test_scout_consent(v_unit,v_parent,v_leader,true);
                when 4 then perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,null);
                when 5 then perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,false);
            end case;
        exception when raise_exception then
            if sqlerrm <> (case v_attempt
                when 1 then 'Verified family relationship required'
                when 2 then 'Select an eligible Scout in this unit'
                when 3 then 'Select an eligible Scout in this unit'
                when 4 then 'Consent decision required'
                when 5 then 'No prior test consent for this relationship' end) then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: invalid consent input %',v_attempt; end if;
    end loop;

    perform public.set_toolbox_family_relationship(v_unit,v_parent,v_scout,'guardian');
    perform public.review_toolbox_access(v_parent_request,true,v_parent,'parent');
    perform public.review_toolbox_access(v_leader_request,true,v_leader,'leader');

    -- Even linked guardians and leaders cannot record consent directly.
    foreach v_id in array array[v_parent_user,v_leader_user,v_scout_user] loop
        perform set_config('request.jwt.claim.sub',v_id::text,true);
        perform set_config('request.jwt.claims',jsonb_build_object('sub',v_id,'role','authenticated')::text,true);
        v_denied := false;
        begin
            perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,true);
        exception when raise_exception then
            if sqlerrm <> 'Administrator access required' then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: non-admin consent recording'; end if;

        v_denied := false;
        begin
            perform 1 from toolbox_private.scout_consent_events;
        exception when insufficient_privilege then v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: non-admin consent table read'; end if;
    end loop;

    perform set_config('request.jwt.claim.sub',v_admin::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    perform public.set_toolbox_member_active(v_unit,v_scout,false);
    v_denied := false;
    begin
        perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,true);
    exception when raise_exception then
        if sqlerrm <> 'Select an eligible Scout in this unit' then raise; end if;
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL: consent for inactive Scout'; end if;
    perform public.set_toolbox_member_active(v_unit,v_scout,true);

    v_event := public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,true);
    if v_event is null then raise exception 'FAIL: consent event missing'; end if;
    if exists (select 1 from public.user_roles where profile_id=v_scout_user)
       or not exists (select 1 from public.access_requests where id=v_scout_request and status='pending') then
        raise exception 'FAIL: consent automatically assigned access';
    end if;

    -- Fictional confirmation must not bypass either Scout role gate.
    for v_attempt in 1..2 loop
        v_denied := false;
        begin
            if v_attempt=1 then
                perform public.review_toolbox_access(v_scout_request,true,v_scout,'scout');
            else
                perform public.grant_toolbox_member_role(v_unit,v_scout,'scout');
            end if;
        exception when raise_exception then
            if sqlerrm <> 'Scout account assignment is not enabled pending consent safeguards' then raise; end if;
            v_denied := true;
        end;
        if not v_denied then raise exception 'FAIL: Scout role gate %',v_attempt; end if;
    end loop;

    -- Withdrawal remains recordable after the family relationship is removed.
    perform public.remove_toolbox_family_relationship(v_unit,v_parent,v_scout);
    perform public.set_toolbox_member_active(v_unit,v_scout,false);
    perform public.record_toolbox_test_scout_consent(v_unit,v_scout,v_parent,false);

    if (select count(*) from public.audit_logs where unit_id=v_unit
        and entity_id=v_scout and actor_profile_id=v_admin
        and action in ('consent.test_confirmed','consent.test_withdrawn')
        and details->>'adult_member_id'=v_parent::text
        and details->>'notice_version'='development-preview-v1') <> 2 then
        raise exception 'FAIL: consent audit entries';
    end if;
    perform set_config('toolbox.test_scout_member',v_scout::text,true);
    perform set_config('toolbox.test_parent_member',v_parent::text,true);
    perform set_config('toolbox.test_consent_event',v_event::text,true);
end;
$$;

reset role;

-- Privileged verification of private event history; never grant table reads.
do $$
declare
    v_unit uuid := current_setting('toolbox.test_unit')::uuid;
    v_scout uuid := current_setting('toolbox.test_scout_member')::uuid;
    v_parent uuid := current_setting('toolbox.test_parent_member')::uuid;
    v_event uuid := current_setting('toolbox.test_consent_event')::uuid;
    v_admin uuid := current_setting('toolbox.test_admin')::uuid;
begin
    if (select count(*) from toolbox_private.scout_consent_events
        where unit_id=v_unit and scout_member_id=v_scout and adult_member_id=v_parent) <> 2
       or not exists (select 1 from toolbox_private.scout_consent_events
        where id=v_event and decision='confirmed' and recorded_by=v_admin
          and notice_version='development-preview-v1')
       or not exists (select 1 from toolbox_private.scout_consent_events
        where unit_id=v_unit and scout_member_id=v_scout and adult_member_id=v_parent
          and decision='withdrawn' and recorded_by=v_admin
          and notice_version='development-preview-v1') then
        raise exception 'FAIL: private consent history';
    end if;
end;
$$;

rollback;

select 'PASS: test consent authorization, private history, withdrawal, audit and Scout role gate' as test_result;
