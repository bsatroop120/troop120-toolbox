-- 005: Registration and manual account approval.
-- Requests do not grant roles or access to member records.
begin;

create table public.access_requests (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null
        references public.profiles(id) on delete cascade,
    unit_id uuid not null
        references public.units(id) on delete restrict,
    requested_role text not null
        references public.roles(code) on delete restrict
        check (requested_role in ('leader', 'parent', 'scout')),
    status text not null default 'pending'
        check (status in ('pending', 'approved', 'denied')),
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewed_by uuid
        references public.profiles(id) on delete restrict,
    constraint access_requests_review_check check (
        (status = 'pending'
            and reviewed_at is null and reviewed_by is null)
        or
        (status in ('approved', 'denied')
            and reviewed_at is not null
            and reviewed_by is not null
            and reviewed_at >= requested_at
            and reviewed_by <> profile_id)
    )
);

create unique index access_requests_pending_idx
    on public.access_requests(profile_id, unit_id, requested_role)
    where status = 'pending';

create index access_requests_unit_status_idx
    on public.access_requests(unit_id, status);

alter table public.access_requests enable row level security;

revoke all privileges on table public.access_requests
    from public, anon, authenticated;

commit;

-- Verify client read access remains disabled.
select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
    has_table_privilege('authenticated', c.oid, 'SELECT')
        as authenticated_can_read
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
    and c.relname = 'access_requests';
