-- 004: Patrol organization and current youth assignments.
-- Client access remains locked until authorization policies are installed.
begin;

create table public.patrols (
    id uuid primary key default gen_random_uuid(),
    unit_id uuid not null
        references public.units(id) on delete restrict,
    name text not null check (length(btrim(name)) > 0),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (unit_id, id)
);

create unique index patrols_unit_name_idx
    on public.patrols(unit_id, lower(btrim(name)));

create table public.patrol_members (
    unit_id uuid not null,
    patrol_id uuid not null,
    member_id uuid not null,
    member_type text not null default 'youth'
        check (member_type = 'youth'),
    assigned_at timestamptz not null default now(),
    primary key (unit_id, member_id),
    foreign key (unit_id, patrol_id)
        references public.patrols(unit_id, id)
        on delete restrict,
    foreign key (unit_id, member_id, member_type)
        references public.members(unit_id, id, member_type)
        on delete restrict
);

create index patrol_members_patrol_idx
    on public.patrol_members(unit_id, patrol_id);

alter table public.patrols enable row level security;
alter table public.patrol_members enable row level security;

revoke all privileges on table
    public.patrols, public.patrol_members
    from public, anon, authenticated;

commit;

select c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_read
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in ('patrols', 'patrol_members')
order by c.relname;
