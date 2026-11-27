-- 010C: Exercise RLS and access requests using existing test accounts.
-- Run the entire script at once, only in the development database.
-- All test writes are rolled back. No real Scout data is required.
begin;

-- Select the sole verified test account without a unit role.
do $$
declare
    v_user uuid;
begin
    select u.id into strict v_user
    from auth.users u
    where u.email_confirmed_at is not null
      and not exists (
          select 1 from public.user_roles r
          where r.profile_id = u.id
      );

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims',
        jsonb_build_object('sub', v_user, 'role', 'authenticated')::text,
        true);
end;
$$;

set local role authenticated;

do $$
declare
    v_request uuid;
    v_denied boolean := false;
begin
    if current_user <> 'authenticated' or auth.uid() is null then
        raise exception 'FAIL: test identity not established';
    end if;

    if exists (select 1 from public.units)
        or exists (select 1 from public.members)
        or exists (select 1 from public.user_roles)
        or exists (select 1 from public.settings)
        or exists (select 1 from public.patrols)
        or exists (select 1 from public.patrol_members)
        or exists (select 1 from public.member_accounts)
        or exists (select 1 from public.family_relationships)
        or exists (select 1 from public.audit_logs)
        or exists (select 1 from public.profiles where id <> auth.uid())
    then
        raise exception 'FAIL: unapproved account can read protected data';
    end if;

    v_request := public.request_toolbox_access('Test Applicant', 'parent');

    if not exists (
        select 1 from public.access_requests
        where id = v_request and status = 'pending'
          and profile_id = auth.uid()
    ) then
        raise exception 'FAIL: request not visible to its owner';
    end if;

    if exists (select 1 from public.user_roles) then
        raise exception 'FAIL: request granted a role automatically';
    end if;

    begin
        perform public.review_toolbox_access(v_request, false, null);
    exception when raise_exception then
        if sqlerrm <> 'Request unavailable or access denied' then
            raise;
        end if;
        v_denied := true;
    end;

    if not v_denied then
        raise exception 'FAIL: unapproved user could review a request';
    end if;

    perform set_config('toolbox.test_request_id', v_request::text, true);
end;
$$;

reset role;

-- Switch to the existing test administrator.
do $$
declare
    v_user uuid;
begin
    select r.profile_id into strict v_user
    from public.user_roles r
    join public.units u on u.id = r.unit_id
    where u.slug = 'troop-120' and r.role_code = 'admin';

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims',
        jsonb_build_object('sub', v_user, 'role', 'authenticated')::text,
        true);
end;
$$;

set local role authenticated;

do $$
declare
    v_request uuid := current_setting('toolbox.test_request_id')::uuid;
begin
    if not exists (select 1 from public.units where slug = 'troop-120')
        or not exists (select 1 from public.members)
        or not exists (
            select 1 from public.access_requests
            where id = v_request and status = 'pending'
        )
        or not exists (
            select 1 from public.audit_logs
            where entity_id = v_request and action = 'access.requested'
        )
    then
        raise exception 'FAIL: administrator cannot read expected data';
    end if;

    perform public.review_toolbox_access(v_request, false, null);

    if not exists (
        select 1 from public.access_requests
        where id = v_request and status = 'denied'
          and reviewed_by = auth.uid()
    ) or not exists (
        select 1 from public.audit_logs
        where entity_id = v_request and action = 'access.denied'
    ) then
        raise exception 'FAIL: administrator review or audit logging failed';
    end if;
end;
$$;

reset role;
rollback;

select 'PASS: account isolation, request submission, review restrictions and administrator denial' as test_result;
