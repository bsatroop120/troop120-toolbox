-- 003: Account-to-member links and verified family relationships.
-- Relationships do not themselves grant access. Keep all client access denied.
begin;

alter table public.members
    add constraint members_unit_id_member_id_key unique (unit_id, id),
    add constraint members_unit_id_member_id_type_key
        unique (unit_id, id, member_type);

create table public.member_accounts (
    profile_id uuid not null
        references public.profiles(id) on delete cascade,
    unit_id uuid not null,
    member_id uuid not null,
    linked_at timestamptz not null default now(),
    primary key (profile_id, unit_id),
    unique (unit_id, member_id),
    foreign key (unit_id, member_id)
        references public.members(unit_id, id) on delete restrict
);

create table public.family_relationships (
    unit_id uuid not null,
    adult_member_id uuid not null,
    scout_member_id uuid not null,
    adult_type text not null default 'adult'
        check (adult_type = 'adult'),
    scout_type text not null default 'youth'
        check (scout_type = 'youth'),
    relationship_type text not null
        check (relationship_type in ('parent', 'guardian')),
    created_at timestamptz not null default now(),
    primary key (unit_id, adult_member_id, scout_member_id),
    foreign key (unit_id, adult_member_id, adult_type)
        references public.members(unit_id, id, member_type)
        on delete restrict,
    foreign key (unit_id, scout_member_id, scout_type)
        references public.members(unit_id, id, member_type)
        on delete restrict
);

create index family_relationships_scout_idx
    on public.family_relationships(unit_id, scout_member_id);

alter table public.member_accounts enable row level security;
alter table public.family_relationships enable row level security;

revoke all privileges on table
    public.member_accounts, public.family_relationships
    from public, anon, authenticated;

commit;

-- Verify client read access remains disabled.
select c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_read
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname in ('member_accounts', 'family_relationships')
order by c.relname;
