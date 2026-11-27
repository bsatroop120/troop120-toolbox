-- 014A: Administrator-managed, verified family relationships.
-- Linking an adult to a Scout does not grant access by itself.
begin;

alter table public.audit_logs
    add column details jsonb not null default '{}'::jsonb;

create function public.set_toolbox_family_relationship(
    p_unit_id uuid,
    p_adult_member_id uuid,
    p_scout_member_id uuid,
    p_relationship_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_old_type text;
begin
    if v_actor is null
       or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;

    if p_relationship_type is null
       or p_relationship_type not in ('parent','guardian') then
        raise exception 'Invalid relationship type';
    end if;

    -- Use the same adult-member lock as role grant and approval.
    perform 1 from public.members
    where unit_id = p_unit_id and id = p_adult_member_id
      and member_type = 'adult' and active
    for update;
    if not found then
        raise exception 'Select an active adult in this unit';
    end if;

    perform 1 from public.members
    where unit_id = p_unit_id and id = p_scout_member_id
      and member_type = 'youth' and active
    for update;
    if not found then
        raise exception 'Select an active Scout in this unit';
    end if;

    select relationship_type into v_old_type
    from public.family_relationships
    where unit_id = p_unit_id
      and adult_member_id = p_adult_member_id
      and scout_member_id = p_scout_member_id;

    if v_old_type = p_relationship_type then return; end if;

    insert into public.family_relationships
        (unit_id, adult_member_id, scout_member_id, relationship_type)
    values (p_unit_id, p_adult_member_id, p_scout_member_id, p_relationship_type)
    on conflict (unit_id, adult_member_id, scout_member_id)
    do update set relationship_type = excluded.relationship_type;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id, details)
    values (
        p_unit_id, v_actor,
        case when v_old_type is null then 'family.linked' else 'family.updated' end,
        'member', p_adult_member_id,
        jsonb_build_object('scout_member_id', p_scout_member_id,
                           'previous_relationship_type', v_old_type,
                           'relationship_type', p_relationship_type)
    );
end;
$$;

create function public.remove_toolbox_family_relationship(
    p_unit_id uuid,
    p_adult_member_id uuid,
    p_scout_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_old_type text;
    v_profile uuid;
begin
    if v_actor is null
       or not toolbox_private.has_staff_access(p_unit_id, true) then
        raise exception 'Administrator access required';
    end if;

    -- Permit removing historical links even when a member is inactive.
    perform 1 from public.members
    where unit_id = p_unit_id and id = p_adult_member_id
      and member_type = 'adult'
    for update;
    if not found then raise exception 'Adult member unavailable'; end if;

    delete from public.family_relationships
    where unit_id = p_unit_id
      and adult_member_id = p_adult_member_id
      and scout_member_id = p_scout_member_id
    returning relationship_type into v_old_type;

    if not found then raise exception 'Family relationship unavailable'; end if;

    insert into public.audit_logs
        (unit_id, actor_profile_id, action, entity_type, entity_id, details)
    values (p_unit_id, v_actor, 'family.unlinked', 'member', p_adult_member_id,
        jsonb_build_object('scout_member_id', p_scout_member_id,
                           'previous_relationship_type', v_old_type));

    -- If no active linked Scout remains, remove only the parent role.
    -- Preserve any independently assigned leader or administrator role.
    if not exists (
        select 1 from public.family_relationships fr
        join public.members child on child.unit_id = fr.unit_id
          and child.id = fr.scout_member_id
        where fr.unit_id = p_unit_id
          and fr.adult_member_id = p_adult_member_id and child.active
    ) then
        select profile_id into v_profile from public.member_accounts
        where unit_id = p_unit_id and member_id = p_adult_member_id;

        delete from public.user_roles
        where unit_id = p_unit_id and profile_id = v_profile and role_code = 'parent';

        if found then
            insert into public.audit_logs
                (unit_id, actor_profile_id, action, entity_type, entity_id, details)
            values (p_unit_id, v_actor, 'role.revoked.parent', 'member',
                    p_adult_member_id,
                    jsonb_build_object('reason','no_active_linked_scout'));
        end if;
    end if;
end;
$$;

revoke all on function public.set_toolbox_family_relationship(uuid,uuid,uuid,text)
    from public,anon,authenticated;
revoke all on function public.remove_toolbox_family_relationship(uuid,uuid,uuid)
    from public,anon,authenticated;

grant execute on function public.set_toolbox_family_relationship(uuid,uuid,uuid,text)
    to authenticated;
grant execute on function public.remove_toolbox_family_relationship(uuid,uuid,uuid)
    to authenticated;

commit;

select p.proname as function_name,
       p.prosecdef as security_definer,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
       has_table_privilege('authenticated','public.family_relationships',
           'INSERT, UPDATE, DELETE, TRUNCATE') as direct_family_write
from pg_catalog.pg_proc p
where p.oid in (
    'public.set_toolbox_family_relationship(uuid,uuid,uuid,text)'::regprocedure,
    'public.remove_toolbox_family_relationship(uuid,uuid,uuid)'::regprocedure
)
order by p.proname;
