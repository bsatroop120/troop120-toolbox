-- 019B: Private BAND event snapshot. No subscription URL or token stored in this table.
begin;

create table public.toolbox_band_events (
  unit_id uuid primary key references public.units(id) on delete restrict,
  events jsonb not null check (
    jsonb_typeof(events) = 'array'
    and jsonb_array_length(events) <= 1000
    and octet_length(events::text) <= 500000
  ),
  refreshed_at timestamptz not null default now()
);

alter table public.toolbox_band_events enable row level security;
revoke all on public.toolbox_band_events from public, anon, authenticated;
grant select on public.toolbox_band_events to authenticated;

create policy band_events_read_member on public.toolbox_band_events
  for select to authenticated
  using (toolbox_private.can_read_album_archive(unit_id));

create function public.can_refresh_toolbox_band_events(p_unit_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null
    and toolbox_private.has_staff_access(p_unit_id, true)
    and exists (
      select 1 from public.units
      where id = p_unit_id and slug = 'troop-120'
    );
$$;

revoke all on function public.can_refresh_toolbox_band_events(uuid)
  from public, anon, authenticated;
grant execute on function public.can_refresh_toolbox_band_events(uuid)
  to authenticated;

create function public.save_toolbox_band_events_snapshot(
  p_unit_id uuid,
  p_actor_id uuid,
  p_events jsonb,
  p_expected_refreshed_at timestamptz
)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_previous timestamptz;
  v_refreshed timestamptz;
begin
  if p_actor_id is null or not exists (
    select 1 from public.units
    where id = p_unit_id and slug = 'troop-120'
  ) then
    raise exception 'Administrator access required';
  end if;

  perform 1 from public.units
    where id = p_unit_id for no key update;

  if not exists (
    select 1 from public.member_accounts ma
    join public.members m
      on m.unit_id = ma.unit_id and m.id = ma.member_id
    join public.user_roles ur
      on ur.unit_id = ma.unit_id and ur.profile_id = ma.profile_id
    where ma.profile_id = p_actor_id
      and ma.unit_id = p_unit_id
      and m.active
      and m.member_type = 'adult'
      and ur.role_code = 'admin'
  ) then
    raise exception 'Administrator access required';
  end if;

  select refreshed_at into v_previous
  from public.toolbox_band_events
  where unit_id = p_unit_id;

  if v_previous is distinct from p_expected_refreshed_at then
    raise exception 'Events changed during sync; reload and retry';
  end if;

  insert into public.toolbox_band_events(unit_id, events, refreshed_at)
  values (p_unit_id, p_events, clock_timestamp())
  on conflict (unit_id) do update
    set events = excluded.events,
        refreshed_at = excluded.refreshed_at
  returning refreshed_at into v_refreshed;

  insert into public.audit_logs(
    unit_id, actor_profile_id, action, entity_type, entity_id
  )
  values (
    p_unit_id, p_actor_id, 'band_events.refreshed', 'band_events', p_unit_id
  );

  return v_refreshed;
end;
$$;

revoke all on function public.save_toolbox_band_events_snapshot(
  uuid,uuid,jsonb,timestamptz
) from public, anon, authenticated, service_role;

grant execute on function public.save_toolbox_band_events_snapshot(
  uuid,uuid,jsonb,timestamptz
) to service_role;

commit;

select
  has_table_privilege(
    'authenticated','public.toolbox_band_events','SELECT'
  ) as member_read_grant,
  has_table_privilege(
    'anon','public.toolbox_band_events','SELECT'
  ) as anonymous_read,
  has_function_privilege(
    'authenticated','public.save_toolbox_band_events_snapshot(uuid,uuid,jsonb,timestamptz)','EXECUTE'
  ) as client_snapshot_write,
  has_function_privilege(
    'service_role','public.save_toolbox_band_events_snapshot(uuid,uuid,jsonb,timestamptz)','EXECUTE'
  ) as server_snapshot_write;
