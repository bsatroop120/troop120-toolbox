-- 022A: Leadership Reports, administrator-only fictional workflow preview.
-- This is intentionally NOT a youth-account, real leadership assignment, or messaging system.
begin;
create table public.toolbox_test_leadership_reports (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete restrict,
  position_code text not null check (position_code in ('quartermaster','scribe','historian','librarian','chaplain-aide','instructor','troop-guide','den-chief','outdoor-ethics','webmaster','bugler','oa-representative')),
  week_of date not null check (week_of >= date '2020-01-01' and extract(isodow from week_of)=1),
  completed text not null check (char_length(completed) between 1 and 1500 and completed ~ '[^[:space:]]'),
  planned text not null default '' check (char_length(planned)<=1500),
  assistance text not null default '' check (char_length(assistance)<=1000),
  review_state text not null default 'submitted' check (review_state in ('submitted','reviewed','follow-up')),
  submitted_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(unit_id,week_of,position_code)
);
alter table public.toolbox_test_leadership_reports enable row level security;
revoke all on public.toolbox_test_leadership_reports from public,anon,authenticated;
grant select on public.toolbox_test_leadership_reports to authenticated;
create policy test_leadership_admin_read on public.toolbox_test_leadership_reports
  for select to authenticated using (toolbox_private.has_staff_access(unit_id,true));

create function public.submit_toolbox_test_leadership_report(
  p_unit_id uuid,p_position text,p_week_of date,p_completed text,p_planned text,p_assistance text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if auth.uid() is null or not exists (select 1 from public.units where id=p_unit_id and slug='troop-120')
  then raise exception 'Administrator access required'; end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if p_position is null or p_position not in ('quartermaster','scribe','historian','librarian','chaplain-aide','instructor','troop-guide','den-chief','outdoor-ethics','webmaster','bugler','oa-representative')
    or p_week_of is null or p_week_of<date '2020-01-01'
    or p_week_of>(clock_timestamp() at time zone 'America/New_York')::date
    or extract(isodow from p_week_of)<>1
    or p_completed is null or char_length(btrim(p_completed)) not between 1 and 1500
    or btrim(p_completed) !~ '[^[:space:]]'
    or char_length(coalesce(p_planned,''))>1500 or char_length(coalesce(p_assistance,''))>1000
  then raise exception 'Invalid report fields'; end if;
  if exists(select 1 from public.toolbox_test_leadership_reports where unit_id=p_unit_id and position_code=p_position and week_of=p_week_of)
  then raise exception 'A test report for this position and week already exists'; end if;
  if (select count(*) from public.toolbox_test_leadership_reports where unit_id=p_unit_id)>=1000
  then raise exception 'Test report capacity reached'; end if;
  insert into public.toolbox_test_leadership_reports(unit_id,position_code,week_of,completed,planned,assistance)
    values(p_unit_id,p_position,p_week_of,btrim(p_completed),btrim(coalesce(p_planned,'')),btrim(coalesce(p_assistance,'')))
    returning id into v_id;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),'test_leadership.submitted','test_leadership_report',v_id);
  return v_id;
end;
$$;
create function public.review_toolbox_test_leadership_report(
  p_unit_id uuid,p_report_id uuid,p_state text,p_expected_updated_at timestamptz
) returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists(select 1 from public.units where id=p_unit_id and slug='troop-120')
  then raise exception 'Administrator access required'; end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if p_state is null or p_state not in ('reviewed','follow-up','submitted') or p_expected_updated_at is null
  then raise exception 'Invalid review status'; end if;
  update public.toolbox_test_leadership_reports
    set review_state=p_state,updated_at=clock_timestamp()
    where unit_id=p_unit_id and id=p_report_id and updated_at=p_expected_updated_at;
  if not found then raise exception 'Report changed; refresh and retry'; end if;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),'test_leadership.review_changed','test_leadership_report',p_report_id);
  return true;
end;
$$;
revoke all on function public.submit_toolbox_test_leadership_report(uuid,text,date,text,text,text),
  public.review_toolbox_test_leadership_report(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.submit_toolbox_test_leadership_report(uuid,text,date,text,text,text),
  public.review_toolbox_test_leadership_report(uuid,uuid,text,timestamptz) to authenticated;
commit;
select
  (select relrowsecurity from pg_catalog.pg_class where oid='public.toolbox_test_leadership_reports'::regclass) as rls_enabled,
  has_table_privilege('anon','public.toolbox_test_leadership_reports','SELECT') as anon_read,
  has_table_privilege('authenticated','public.toolbox_test_leadership_reports','SELECT') as authenticated_select,
  has_table_privilege('authenticated','public.toolbox_test_leadership_reports','INSERT,UPDATE,DELETE') as direct_write,
  has_function_privilege('anon','public.submit_toolbox_test_leadership_report(uuid,text,date,text,text,text)','EXECUTE') as anon_submit,
  has_function_privilege('authenticated','public.submit_toolbox_test_leadership_report(uuid,text,date,text,text,text)','EXECUTE') as authenticated_submit_rpc,
  has_function_privilege('authenticated','public.review_toolbox_test_leadership_report(uuid,uuid,text,timestamptz)','EXECUTE') as authenticated_review_rpc;
