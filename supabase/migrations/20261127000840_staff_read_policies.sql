-- 008E: Unit-scoped, read-only leader and administrator access.
-- Administrative writes are deliberately deferred.
begin;

create function toolbox_private.has_staff_access(
    p_unit_id uuid, p_admin_only boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.user_roles ur
        join public.member_accounts ma
          on ma.profile_id = ur.profile_id
         and ma.unit_id = ur.unit_id
        join public.members m
          on m.unit_id = ma.unit_id
         and m.id = ma.member_id
        where ur.profile_id = (select auth.uid())
          and ur.unit_id = p_unit_id
          and m.member_type = 'adult'
          and m.active
          and (
              ur.role_code = 'admin'
              or (not p_admin_only and ur.role_code = 'leader')
          )
    );
$$;

revoke all on function
    toolbox_private.has_staff_access(uuid, boolean)
    from public, anon, authenticated;
grant execute on function
    toolbox_private.has_staff_access(uuid, boolean)
    to authenticated;

-- Adult leaders and administrators: unit roster and patrols.
create policy members_read_staff
    on public.members for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, false));

create policy patrols_read_staff
    on public.patrols for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, false));

create policy patrol_members_read_staff
    on public.patrol_members for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, false));

-- Administrators only: account links, family relationships and approvals.
create policy member_accounts_read_admin
    on public.member_accounts for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, true));

create policy family_relationships_read_admin
    on public.family_relationships for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, true));

create policy user_roles_read_admin
    on public.user_roles for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, true));

create policy access_requests_read_admin
    on public.access_requests for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, true));

create policy profiles_read_admin
    on public.profiles for select to authenticated
    using (
        exists (
            select 1 from public.user_roles ur
            where ur.profile_id = profiles.id
              and toolbox_private.has_staff_access(ur.unit_id, true)
        )
        or exists (
            select 1 from public.access_requests ar
            where ar.profile_id = profiles.id
              and toolbox_private.has_staff_access(ar.unit_id, true)
        )
    );

create policy audit_logs_read_admin
    on public.audit_logs for select to authenticated
    using (toolbox_private.has_staff_access(unit_id, true));

grant select on public.audit_logs to authenticated;

commit;

-- Verify all affected tables retain RLS and read-only grants.
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
    and c.relname in (
        'members', 'patrols', 'patrol_members',
        'member_accounts', 'family_relationships',
        'user_roles', 'access_requests', 'profiles',
        'audit_logs'
    )
order by c.relname;
