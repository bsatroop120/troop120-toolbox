-- 021C: Admin-only additions and corrections to the existing Eagle honor roll.
-- Preserves every existing row; no deletion or reimport.
begin;

alter table public.toolbox_eagle_honor_roll
  add column updated_at timestamptz not null default clock_timestamp();

create function public.save_toolbox_eagle_honor(
  p_unit_id uuid,
  p_eagle_id uuid,
  p_display_name text,
  p_earned_on date,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := btrim(p_display_name);
  v_id uuid;
  v_order integer;
  v_action text;
begin
  if auth.uid() is null
    or not toolbox_private.has_staff_access(p_unit_id,true)
    or not exists (select 1 from public.units where id=p_unit_id and slug='troop-120')
  then raise exception 'Administrator access required'; end if;

  perform toolbox_private.lock_family_lifecycle(p_unit_id);

  if v_name is null or char_length(v_name) not between 1 and 160
    or v_name !~ '[^[:space:]]' or v_name ~ '[[:cntrl:]]'
  then raise exception 'Enter a valid Eagle Scout name'; end if;
  if p_earned_on is null or p_earned_on < date '1912-01-01'
    or p_earned_on > (clock_timestamp() at time zone 'America/New_York')::date
  then raise exception 'Enter a valid past or current advancement date'; end if;
  if exists (
    select 1 from public.toolbox_eagle_honor_roll
    where unit_id=p_unit_id and lower(display_name)=lower(v_name)
      and earned_on=p_earned_on and id is distinct from p_eagle_id
  ) then raise exception 'This name and date already exist'; end if;

  if p_eagle_id is null then
    if p_expected_updated_at is not null then raise exception 'Invalid new record'; end if;
    select coalesce(max(display_order),0)+1 into v_order
      from public.toolbox_eagle_honor_roll where unit_id=p_unit_id;
    if v_order>10000 then raise exception 'Honor roll capacity reached'; end if;
    insert into public.toolbox_eagle_honor_roll
      (unit_id,display_name,earned_on,eagle_year,display_order,updated_at)
      values(p_unit_id,v_name,p_earned_on,extract(year from p_earned_on)::integer,v_order,clock_timestamp())
      returning id into v_id;
    v_action:='eagle_honor.added';
  else
    if p_expected_updated_at is null then raise exception 'Reload the record before editing'; end if;
    update public.toolbox_eagle_honor_roll
      set display_name=v_name,earned_on=p_earned_on,
        eagle_year=extract(year from p_earned_on)::integer,updated_at=clock_timestamp()
      where unit_id=p_unit_id and id=p_eagle_id and updated_at=p_expected_updated_at
      returning id into v_id;
    if not found then raise exception 'Record changed or unavailable; reload before editing'; end if;
    v_action:='eagle_honor.updated';
  end if;

  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),v_action,'eagle_honor',v_id);
  return v_id;
end;
$$;

revoke all on function public.save_toolbox_eagle_honor(uuid,uuid,text,date,timestamptz)
  from public,anon,authenticated;
grant execute on function public.save_toolbox_eagle_honor(uuid,uuid,text,date,timestamptz)
  to authenticated;

commit;

select
  (select count(*) from public.toolbox_eagle_honor_roll e
    join public.units u on u.id=e.unit_id where u.slug='troop-120') as preserved_eagles,
  has_table_privilege('anon','public.toolbox_eagle_honor_roll','SELECT') as anonymous_read,
  has_table_privilege('authenticated','public.toolbox_eagle_honor_roll','INSERT,UPDATE,DELETE') as direct_write,
  has_function_privilege('anon','public.save_toolbox_eagle_honor(uuid,uuid,text,date,timestamptz)','EXECUTE') as anonymous_save,
  has_function_privilege('authenticated','public.save_toolbox_eagle_honor(uuid,uuid,text,date,timestamptz)','EXECUTE') as authenticated_rpc;
