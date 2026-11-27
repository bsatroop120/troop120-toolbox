-- 006: Audit log foundation. No direct application access.
begin;

create table public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    unit_id uuid not null
        references public.units(id) on delete restrict,
    actor_profile_id uuid,
    action text not null
        check (action ~ '^[a-z][a-z0-9_.]{0,79}$'),
    entity_type text not null
        check (entity_type ~ '^[a-z][a-z0-9_]{0,79}$'),
    entity_id uuid,
    occurred_at timestamptz not null default now()
);

create index audit_logs_unit_time_idx
    on public.audit_logs(unit_id, occurred_at desc);

alter table public.audit_logs enable row level security;

revoke all privileges on table public.audit_logs
    from public, anon, authenticated;

commit;

-- Verify RLS and absence of client table privileges.
select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT')
        as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT')
        as authenticated_can_read,
    has_table_privilege('authenticated', c.oid,
        'INSERT, UPDATE, DELETE, TRUNCATE')
        as authenticated_can_write
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n
    on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname = 'audit_logs';
