-- 002: Unit-scoped application roles. No client access yet.
begin;

create table public.roles (
    code text primary key,
    name text not null unique
);

insert into public.roles (code, name) values
    ('admin', 'Administrator'),
    ('leader', 'Adult leader'),
    ('parent', 'Parent or guardian'),
    ('scout', 'Scout');

create table public.user_roles (
    profile_id uuid not null references public.profiles(id) on delete cascade,
    unit_id uuid not null references public.units(id) on delete restrict,
    role_code text not null references public.roles(code) on delete restrict,
    assigned_at timestamptz not null default now(),
    primary key (profile_id, unit_id, role_code)
);

create index user_roles_unit_idx on public.user_roles(unit_id);

alter table public.roles enable row level security;
alter table public.user_roles enable row level security;

revoke all privileges on table public.roles, public.user_roles
    from public, anon, authenticated;

commit;

-- Verify security and seeded role count.
select c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_read,
    (select count(*) from public.roles) as role_count
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in ('roles', 'user_roles')
order by c.relname;
