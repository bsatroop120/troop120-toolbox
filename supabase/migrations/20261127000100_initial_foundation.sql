-- Troop 120 Toolbox: initial locked-down database foundation.
-- Apply once in the Supabase SQL Editor as the database administrator.
-- No client access is granted until explicit authorization policies are added.

begin;

create table public.units (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(btrim(name)) > 0),
    slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    created_at timestamptz not null default now()
);

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text check (display_name is null or length(btrim(display_name)) > 0),
    created_at timestamptz not null default now()
);

create table public.members (
    id uuid primary key default gen_random_uuid(),
    unit_id uuid not null references public.units(id) on delete restrict,
    display_name text not null check (length(btrim(display_name)) > 0),
    member_type text not null check (member_type in ('youth', 'adult')),
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create index members_unit_id_idx on public.members(unit_id);

alter table public.units enable row level security;
alter table public.profiles enable row level security;
alter table public.members enable row level security;

revoke all privileges on table
    public.units, public.profiles, public.members
    from public, anon, authenticated;

-- Only the unit name is seeded; no personal or youth information.
insert into public.units (name, slug)
values ('Troop 120', 'troop-120');

commit;

-- Confirm that all three tables exist, have RLS enabled,
-- and do not allow anonymous or authenticated clients to read them.
select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_read
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('units', 'profiles', 'members')
order by c.relname;
