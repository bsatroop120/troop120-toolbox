-- 008D: Read-only patrol access for Scouts and verified parents.
-- Only own/linked Scout assignments are visible; no peer roster access.
begin;

create policy patrol_members_read_self_or_child
    on public.patrol_members
    for select to authenticated
    using (
        toolbox_private.can_read_member(unit_id, member_id)
    );

create policy patrols_read_assigned
    on public.patrols
    for select to authenticated
    using (
        active
        and exists (
            select 1
            from public.patrol_members pm
            where pm.unit_id = patrols.unit_id
              and pm.patrol_id = patrols.id
              and toolbox_private.can_read_member(
                  pm.unit_id, pm.member_id
              )
        )
    );

grant select on table
    public.patrols, public.patrol_members
    to authenticated;

commit;

-- Verify permissions and policy counts.
select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT')
        as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT')
        as authenticated_can_read,
    has_table_privilege('authenticated', c.oid,
        'INSERT, UPDATE, DELETE, TRUNCATE')
        as authenticated_can_write,
    (select count(*) from pg_catalog.pg_policies p
        where p.schemaname = n.nspname
          and p.tablename = c.relname
          and p.cmd = 'SELECT') as select_policies
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in ('patrols', 'patrol_members')
order by c.relname;
