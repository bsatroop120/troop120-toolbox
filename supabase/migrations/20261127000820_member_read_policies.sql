-- 008C: Read-only access to own member record and linked Scouts.
begin;

create schema toolbox_private;
revoke all on schema toolbox_private
    from public, anon, authenticated;
grant usage on schema toolbox_private to authenticated;

-- Internal helper: checks the caller's active member link and assigned roles.
create function toolbox_private.can_read_member(
    p_unit_id uuid, p_member_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.member_accounts ma
        join public.members own
          on own.unit_id = ma.unit_id
         and own.id = ma.member_id
        join public.members target
          on target.unit_id = ma.unit_id
         and target.id = p_member_id
        join public.user_roles ur
          on ur.profile_id = ma.profile_id
         and ur.unit_id = ma.unit_id
        where ma.profile_id = (select auth.uid())
          and ma.unit_id = p_unit_id
          and own.active and target.active
          and (
              (own.id = target.id and (
                  (own.member_type = 'youth'
                      and ur.role_code = 'scout')
                  or
                  (own.member_type = 'adult'
                      and ur.role_code in ('parent', 'leader', 'admin'))
              ))
              or
              (own.member_type = 'adult'
                  and target.member_type = 'youth'
                  and ur.role_code = 'parent'
                  and exists (
                      select 1 from public.family_relationships fr
                      where fr.unit_id = ma.unit_id
                        and fr.adult_member_id = own.id
                        and fr.scout_member_id = target.id
                  ))
          )
    );
$$;

revoke all on function
    toolbox_private.can_read_member(uuid, uuid)
    from public, anon, authenticated;
grant execute on function
    toolbox_private.can_read_member(uuid, uuid)
    to authenticated;

create policy members_read_self_or_child
    on public.members
    for select to authenticated
    using (toolbox_private.can_read_member(unit_id, id));

create policy member_accounts_read_own
    on public.member_accounts
    for select to authenticated
    using (
        profile_id = (select auth.uid())
        and toolbox_private.can_read_member(unit_id, member_id)
    );

create policy family_relationships_read_parent
    on public.family_relationships
    for select to authenticated
    using (
        toolbox_private.can_read_member(unit_id, adult_member_id)
        and toolbox_private.can_read_member(unit_id, scout_member_id)
        and exists (
            select 1 from public.user_roles ur
            where ur.unit_id = family_relationships.unit_id
              and ur.profile_id = (select auth.uid())
              and ur.role_code = 'parent'
        )
    );

grant select on table
    public.members, public.member_accounts,
    public.family_relationships
    to authenticated;

commit;

-- Verify grants and policy counts, not yet actual account isolation.
select c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT')
        as authenticated_can_read,
    has_table_privilege('authenticated', c.oid,
        'INSERT, UPDATE, DELETE, TRUNCATE') as authenticated_can_write,
    (select count(*) from pg_catalog.pg_policies p
        where p.schemaname = n.nspname
          and p.tablename = c.relname
          and p.cmd = 'SELECT') as select_policies
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in (
        'members', 'member_accounts', 'family_relationships'
    )
order by c.relname;
