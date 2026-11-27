-- 008B: Read-only unit information for users with assigned unit roles.
-- The role catalog contains static labels, not user assignments.
begin;

create policy units_read_assigned
    on public.units
    for select to authenticated
    using (exists (
        select 1 from public.user_roles ur
        where ur.unit_id = units.id
          and ur.profile_id = (select auth.uid())
    ));

create policy settings_read_assigned
    on public.settings
    for select to authenticated
    using (exists (
        select 1 from public.user_roles ur
        where ur.unit_id = settings.unit_id
          and ur.profile_id = (select auth.uid())
    ));

create policy roles_read_catalog
    on public.roles
    for select to authenticated
    using (true);

grant select on table
    public.units, public.settings, public.roles
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
    and c.relname in ('units', 'settings', 'roles')
order by c.relname;
