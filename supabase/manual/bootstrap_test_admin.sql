-- Manual one-time test administrator bootstrap.
-- Run only in the Supabase SQL Editor with database administrator privileges.
-- Replace the placeholder email locally. Do not commit real account details.
-- Never add this script to automated schema migrations.
begin;

do $$
declare
    v_email text := 'REPLACE_WITH_VERIFIED_GOOGLE_EMAIL';
    v_name text := 'Toolbox Test Administrator';
    v_user_id uuid;
    v_unit_id uuid;
    v_member_id uuid;
begin
    select id into strict v_unit_id
    from public.units
    where slug = 'troop-120'
    for update;

    if exists (
        select 1 from public.user_roles
        where unit_id = v_unit_id and role_code = 'admin'
    ) then
        raise exception 'An administrator already exists';
    end if;

    select id into strict v_user_id
    from auth.users
    where lower(email) = lower(v_email)
      and email_confirmed_at is not null;

    if exists (
        select 1 from public.member_accounts
        where profile_id = v_user_id and unit_id = v_unit_id
    ) then
        raise exception 'Account already linked; review manually';
    end if;

    insert into public.profiles (id, display_name)
    values (v_user_id, v_name)
    on conflict (id) do nothing;

    insert into public.members (
        unit_id, display_name, member_type
    )
    values (v_unit_id, v_name, 'adult')
    returning id into v_member_id;

    insert into public.member_accounts (
        profile_id, unit_id, member_id
    )
    values (v_user_id, v_unit_id, v_member_id);

    insert into public.user_roles (
        profile_id, unit_id, role_code
    )
    values
        (v_user_id, v_unit_id, 'admin'),
        (v_user_id, v_unit_id, 'leader')
    on conflict do nothing;

    -- A database operator, not a signed-in app user, performed this action.
    insert into public.audit_logs (
        unit_id, actor_profile_id, action, entity_type, entity_id
    )
    values (
        v_unit_id, null, 'admin.bootstrap', 'profile', v_user_id
    );
end;
$$;

commit;

select ur.role_code, m.member_type, m.active
from public.user_roles ur
join public.units u on u.id = ur.unit_id
join public.member_accounts ma
    on ma.profile_id = ur.profile_id and ma.unit_id = ur.unit_id
join public.members m
    on m.id = ma.member_id and m.unit_id = ma.unit_id
where u.slug = 'troop-120'
  and exists (
      select 1 from public.user_roles ar
      where ar.profile_id = ur.profile_id
        and ar.unit_id = ur.unit_id
        and ar.role_code = 'admin'
  )
order by ur.role_code;
