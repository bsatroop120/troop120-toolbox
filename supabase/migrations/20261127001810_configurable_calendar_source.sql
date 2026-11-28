-- 018G: Configurable calendar source. Preserve the existing calendar.
begin;
alter table public.toolbox_troop_calendar
  drop constraint toolbox_troop_calendar_source_url_check;
alter table public.toolbox_troop_calendar
  add constraint toolbox_troop_calendar_source_url_check
  check (source_url ~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]{10,200}/edit[?]gid=[0-9]{1,10}$');

-- Replace the old write entry point. An outdated refresh function must
-- not overwrite a source that an administrator has since changed.
drop function public.save_toolbox_troop_calendar_snapshot(uuid,uuid,text,text,jsonb,timestamptz);

create function public.save_toolbox_troop_calendar_snapshot(
  p_unit_id uuid,p_actor_id uuid,p_source_url text,p_title text,
  p_calendar jsonb,p_source_modified_at timestamptz,
  p_expected_refreshed_at timestamptz
)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_refreshed timestamptz; v_previous timestamptz; v_previous_url text; v_previous_refresh timestamptz;
begin
  if p_actor_id is null or not exists(
    select 1 from public.units where id=p_unit_id and slug='troop-120'
  ) then raise exception 'Administrator access required'; end if;
  perform 1 from public.units where id=p_unit_id for no key update;
  if not exists(
    select 1 from public.member_accounts ma
    join public.members m on m.unit_id=ma.unit_id and m.id=ma.member_id
    join public.user_roles ur on ur.unit_id=ma.unit_id and ur.profile_id=ma.profile_id
    where ma.profile_id=p_actor_id and ma.unit_id=p_unit_id and m.active
      and m.member_type='adult' and ur.role_code='admin'
  ) then raise exception 'Administrator access required'; end if;
  select source_modified_at,source_url,refreshed_at into v_previous,v_previous_url,v_previous_refresh
  from public.toolbox_troop_calendar where unit_id=p_unit_id;
  if v_previous_refresh is distinct from p_expected_refreshed_at then
    raise exception 'Calendar changed during refresh; reload and retry';
  end if;
  if v_previous_url=p_source_url and v_previous is not null and p_source_modified_at<v_previous then
    raise exception 'A newer document has already been imported';
  end if;
  insert into public.toolbox_troop_calendar(unit_id,source_url,title,calendar_data,source_modified_at,refreshed_at)
  values(p_unit_id,p_source_url,btrim(p_title),p_calendar,p_source_modified_at,clock_timestamp())
  on conflict(unit_id) do update set source_url=excluded.source_url,title=excluded.title,
    calendar_data=excluded.calendar_data,source_modified_at=excluded.source_modified_at,refreshed_at=excluded.refreshed_at
  returning refreshed_at into v_refreshed;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,p_actor_id,'calendar.refreshed','troop_calendar',p_unit_id);
  return v_refreshed;
end;
$$;
revoke all on function public.save_toolbox_troop_calendar_snapshot(uuid,uuid,text,text,jsonb,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.save_toolbox_troop_calendar_snapshot(uuid,uuid,text,text,jsonb,timestamptz,timestamptz) to service_role;
commit;
select
  has_table_privilege('authenticated','public.toolbox_troop_calendar','SELECT') as member_read_grant,
  has_table_privilege('anon','public.toolbox_troop_calendar','SELECT') as anonymous_read,
  has_function_privilege('authenticated','public.save_toolbox_troop_calendar_snapshot(uuid,uuid,text,text,jsonb,timestamptz,timestamptz)','EXECUTE') as client_snapshot_write,
  has_function_privilege('service_role','public.save_toolbox_troop_calendar_snapshot(uuid,uuid,text,text,jsonb,timestamptz,timestamptz)','EXECUTE') as server_snapshot_write,
  (select count(*) from public.toolbox_troop_calendar) as preserved_calendars;
