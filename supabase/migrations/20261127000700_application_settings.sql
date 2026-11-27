-- 007: Unit-level non-secret application settings.
begin;

create table public.settings (
    unit_id uuid primary key
        references public.units(id) on delete restrict,
    time_zone text not null,
    updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

revoke all privileges on table public.settings
    from public, anon, authenticated;

-- Initial settings for Troop 120.
insert into public.settings (unit_id, time_zone)
select id, 'America/New_York'
from public.units
where slug = 'troop-120';

commit;

-- Verify settings and client read/write restrictions.
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
    (select s.time_zone from public.settings s
        join public.units u on u.id = s.unit_id
        where u.slug = 'troop-120') as time_zone
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n
    on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname = 'settings';
