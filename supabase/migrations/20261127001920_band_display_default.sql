-- 019G: Troop-wide default upcoming BAND event display window.
begin;

alter table public.settings
  add column band_default_months integer not null default 2
  check (band_default_months in (0,2,3,8,12));

create function public.set_toolbox_band_default_months(
  p_unit_id uuid, p_months integer
)
returns integer
language plpgsql security definer set search_path = ''
as $$
begin
  if p_months is null or p_months not in (0,2,3,8,12) then
    raise exception 'Invalid event display range';
  end if;
  if auth.uid() is null
    or not toolbox_private.has_staff_access(p_unit_id,true)
    or not exists (
      select 1 from public.units where id=p_unit_id and slug='troop-120'
    )
  then
    raise exception 'Administrator access required';
  end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  update public.settings
    set band_default_months=p_months,updated_at=clock_timestamp()
    where unit_id=p_unit_id;
  if not found then raise exception 'Troop settings unavailable'; end if;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),'band_events.default_changed','settings',p_unit_id);
  return p_months;
end;
$$;

revoke all on function public.set_toolbox_band_default_months(uuid,integer)
  from public,anon,authenticated;
grant execute on function public.set_toolbox_band_default_months(uuid,integer)
  to authenticated;

commit;

select
  (select s.band_default_months from public.settings s
    join public.units u on u.id=s.unit_id where u.slug='troop-120') as default_months,
  has_function_privilege('anon','public.set_toolbox_band_default_months(uuid,integer)','EXECUTE') as anon_can_set,
  has_function_privilege('authenticated','public.set_toolbox_band_default_months(uuid,integer)','EXECUTE') as authenticated_rpc,
  has_table_privilege('authenticated','public.settings','UPDATE') as direct_update;
