-- 021A: Historical Eagle Scout honor roll. Import only approved recognition information.
begin;
create table public.toolbox_eagle_honor_roll (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete restrict,
  display_name text not null check (char_length(display_name) between 1 and 160 and display_name=btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  eagle_year integer check (eagle_year between 1912 and 2200),
  display_order integer not null check (display_order between 1 and 10000),
  unique (unit_id,display_order)
);
alter table public.toolbox_eagle_honor_roll enable row level security;
revoke all on public.toolbox_eagle_honor_roll from public,anon,authenticated;
grant select on public.toolbox_eagle_honor_roll to authenticated;
create policy eagle_honor_roll_read_member on public.toolbox_eagle_honor_roll
  for select to authenticated using (toolbox_private.can_read_album_archive(unit_id));
-- The roster is intentionally empty until the source list can be verified.
commit;
select
  has_table_privilege('authenticated','public.toolbox_eagle_honor_roll','SELECT') as member_read_grant,
  has_table_privilege('anon','public.toolbox_eagle_honor_roll','SELECT') as anonymous_read,
  has_table_privilege('authenticated','public.toolbox_eagle_honor_roll','INSERT,UPDATE,DELETE') as direct_write,
  (select relrowsecurity from pg_catalog.pg_class where oid='public.toolbox_eagle_honor_roll'::regclass) as rls_enabled;
