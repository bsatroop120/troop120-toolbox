-- 017A: Private searchable bylaws snapshot, one per unit.
begin;
create table public.toolbox_bylaws (
  unit_id uuid primary key references public.units(id) on delete restrict,
  source_url text not null check (source_url ~ '^https://docs[.]google[.]com/document/d/[A-Za-z0-9_-]+/edit$'),
  title text not null check (length(btrim(title)) between 1 and 240),
  body_text text not null check (length(btrim(body_text)) between 100 and 250000),
  source_modified_at timestamptz not null,
  refreshed_at timestamptz not null default now()
);
alter table public.toolbox_bylaws enable row level security;
revoke all on public.toolbox_bylaws from public,anon,authenticated;
grant select on public.toolbox_bylaws to authenticated;
create policy bylaws_read_member on public.toolbox_bylaws
  for select to authenticated using (toolbox_private.can_read_album_archive(unit_id));

-- Explicit, independent authorization for the server-side Google lookup.
create function public.can_refresh_toolbox_bylaws(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and toolbox_private.has_staff_access(p_unit_id,true)
    and exists(select 1 from public.units where id=p_unit_id and slug='troop-120');
$$;
revoke all on function public.can_refresh_toolbox_bylaws(uuid) from public,anon,authenticated;
grant execute on function public.can_refresh_toolbox_bylaws(uuid) to authenticated;

-- Only the Edge Function's server credential may write a fetched snapshot.
-- Validate the original caller's active administrator role again before writing.
create function public.save_toolbox_bylaws_snapshot(
  p_unit_id uuid,p_actor_id uuid,p_source_url text,p_title text,
  p_body_text text,p_source_modified_at timestamptz
)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_refreshed timestamptz; v_previous timestamptz;
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
  select source_modified_at into v_previous from public.toolbox_bylaws where unit_id=p_unit_id;
  if v_previous is not null and p_source_modified_at<v_previous then
    raise exception 'A newer document has already been imported';
  end if;
  insert into public.toolbox_bylaws(unit_id,source_url,title,body_text,source_modified_at,refreshed_at)
  values(p_unit_id,p_source_url,btrim(p_title),p_body_text,p_source_modified_at,clock_timestamp())
  on conflict(unit_id) do update set source_url=excluded.source_url,title=excluded.title,
    body_text=excluded.body_text,source_modified_at=excluded.source_modified_at,refreshed_at=excluded.refreshed_at
  returning refreshed_at into v_refreshed;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,p_actor_id,'bylaws.refreshed','bylaws',p_unit_id);
  return v_refreshed;
end;
$$;
revoke all on function public.save_toolbox_bylaws_snapshot(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.save_toolbox_bylaws_snapshot(uuid,uuid,text,text,text,timestamptz) to service_role;
commit;
select
  has_table_privilege('authenticated','public.toolbox_bylaws','SELECT') as member_read_grant,
  has_table_privilege('anon','public.toolbox_bylaws','SELECT') as anonymous_read,
  has_function_privilege('authenticated','public.save_toolbox_bylaws_snapshot(uuid,uuid,text,text,text,timestamptz)','EXECUTE') as client_snapshot_write,
  has_function_privilege('service_role','public.save_toolbox_bylaws_snapshot(uuid,uuid,text,text,text,timestamptz)','EXECUTE') as server_snapshot_write;
