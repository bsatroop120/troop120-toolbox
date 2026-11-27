-- 012A: Administrator-controlled membership lifecycle and role revocation.
-- Keep account links and historical requests; never restore roles automatically.
begin;

create function public.update_toolbox_member_name(
    p_unit_id uuid, p_member_id uuid, p_display_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
begin
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;

    if p_display_name is null or length(btrim(p_display_name)) not between 1 and 100 then
        raise exception 'Enter a valid member name';
    end if;

    update public.members
    set display_name = btrim(p_display_name)
    where unit_id = p_unit_id and id = p_member_id;
    if not found then
        raise exception 'Member unavailable';
    end if;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id)
    values (p_unit_id, v_actor, 'member.name_updated', 'member', p_member_id);
end;
$$;

create function public.set_toolbox_member_active(
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

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id)
    values (p_unit_id, v_actor,
        case when p_active then 'member.reactivated' else 'member.deactivated' end,
        'member', p_member_id);
end;
$$;

create function public.revoke_toolbox_member_role(
    p_unit_id uuid, p_member_id uuid, p_role_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_profile uuid;
begin
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;
    if p_role_code is null or p_role_code not in ('leader','parent','scout') then
        raise exception 'Role cannot be revoked through this function';
    end if;

    -- Same member lock used by account approval and membership status changes.
    perform 1 from public.members
    where unit_id = p_unit_id and id = p_member_id
    for update;
    if not found then
        raise exception 'Member unavailable';
    end if;

    select ma.profile_id into v_profile
    from public.member_accounts ma
    where ma.unit_id = p_unit_id and ma.member_id = p_member_id;
    if not found then
        raise exception 'Member has no linked account';
    end if;

    if v_profile = v_actor or exists (
        select 1 from public.user_roles ur
        where ur.unit_id = p_unit_id and ur.profile_id = v_profile
          and ur.role_code = 'admin'
    ) then
        raise exception 'Administrator account is protected';
    end if;

    delete from public.user_roles
    where unit_id = p_unit_id and profile_id = v_profile
      and role_code = p_role_code;
    if not found then
        raise exception 'Role not assigned';
    end if;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id)
    values (p_unit_id, v_actor, 'role.revoked.' || p_role_code, 'member', p_member_id);
end;
$$;

revoke all on function public.update_toolbox_member_name(uuid,uuid,text)
    from public, anon, authenticated;
revoke all on function public.set_toolbox_member_active(uuid,uuid,boolean)
    from public, anon, authenticated;
revoke all on function public.revoke_toolbox_member_role(uuid,uuid,text)
    from public, anon, authenticated;

grant execute on function public.update_toolbox_member_name(uuid,uuid,text) to authenticated;
grant execute on function public.set_toolbox_member_active(uuid,uuid,boolean) to authenticated;
grant execute on function public.revoke_toolbox_member_role(uuid,uuid,text) to authenticated;

commit;

select
    p.proname as function_name,
    p.prosecdef as security_definer,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
    has_table_privilege('authenticated','public.members','INSERT, UPDATE, DELETE, TRUNCATE')
        as direct_member_write,
    has_table_privilege('authenticated','public.user_roles','INSERT, UPDATE, DELETE, TRUNCATE')
        as direct_role_write
from pg_catalog.pg_proc p
where p.oid in (
    'public.update_toolbox_member_name(uuid,uuid,text)'::regprocedure,
    'public.set_toolbox_member_active(uuid,uuid,boolean)'::regprocedure,
    'public.revoke_toolbox_member_role(uuid,uuid,text)'::regprocedure
)
order by p.proname;
