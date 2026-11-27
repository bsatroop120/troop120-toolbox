-- 008A: Read-only access to the signed-in user's own account records.
-- No roster, family, patrol, or administrative access is granted here.
begin;

create policy profiles_read_own
    on public.profiles
    for select to authenticated
    using (id = (select auth.uid()));

create policy user_roles_read_own
    on public.user_roles
    for select to authenticated
    using (profile_id = (select auth.uid()));

create policy access_requests_read_own
    on public.access_requests
    for select to authenticated
    using (profile_id = (select auth.uid()));

grant select on table
    public.profiles,
    public.user_roles,
    public.access_requests
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
    (select count(*)
        from pg_catalog.pg_policies p
        where p.schemaname = n.nspname
          and p.tablename = c.relname
          and p.cmd = 'SELECT') as select_policies
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in (
        'profiles', 'user_roles', 'access_requests'
    )
order by c.relname;
