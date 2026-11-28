-- 020A: Private, troop-wide announcements. Active members read; adult admins add/remove.
begin;

create table public.toolbox_announcements (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete restrict,
  body text not null check (
    char_length(body) between 1 and 240
    and body = btrim(body)
    and body !~ '[[:cntrl:]]'
    and body ~ '[^[:space:]]'
  ),
  created_at timestamptz not null default clock_timestamp()
);

create index toolbox_announcements_unit_created_idx
  on public.toolbox_announcements(unit_id,created_at desc,id);

alter table public.toolbox_announcements enable row level security;
revoke all on public.toolbox_announcements from public,anon,authenticated;
grant select on public.toolbox_announcements to authenticated;

create policy announcements_read_member on public.toolbox_announcements
  for select to authenticated
  using (toolbox_private.can_read_album_archive(unit_id));

create function public.add_toolbox_announcement(p_unit_id uuid,p_body text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_body text := btrim(regexp_replace(p_body,'[[:space:]]+',' ','g'));
begin
  if auth.uid() is null
    or not toolbox_private.has_staff_access(p_unit_id,true)
    or not exists (select 1 from public.units where id=p_unit_id and slug='troop-120')
  then raise exception 'Administrator access required'; end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if v_body is null or char_length(v_body) not between 1 and 240 or v_body ~ '[[:cntrl:]]'
  then raise exception 'Enter an announcement of 1 to 240 characters'; end if;
  if (select count(*) from public.toolbox_announcements where unit_id=p_unit_id)>=30
  then raise exception 'Remove an old announcement before adding another (maximum 30)'; end if;
  insert into public.toolbox_announcements(unit_id,body)
    values(p_unit_id,v_body) returning id into v_id;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),'announcement.added','announcement',v_id);
  return v_id;
end;
$$;

create function public.remove_toolbox_announcement(p_unit_id uuid,p_announcement_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null
    or not toolbox_private.has_staff_access(p_unit_id,true)
    or not exists (select 1 from public.units where id=p_unit_id and slug='troop-120')
  then raise exception 'Administrator access required'; end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  delete from public.toolbox_announcements
    where unit_id=p_unit_id and id=p_announcement_id;
  if not found then raise exception 'Announcement not found'; end if;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,auth.uid(),'announcement.removed','announcement',p_announcement_id);
  return true;
end;
$$;

revoke all on function public.add_toolbox_announcement(uuid,text),
  public.remove_toolbox_announcement(uuid,uuid) from public,anon,authenticated;
grant execute on function public.add_toolbox_announcement(uuid,text),
  public.remove_toolbox_announcement(uuid,uuid) to authenticated;

commit;

select
  (select relrowsecurity from pg_catalog.pg_class
    where oid='public.toolbox_announcements'::regclass) as rls_enabled,
  has_table_privilege('authenticated','public.toolbox_announcements','SELECT') as member_read_grant,
  has_table_privilege('anon','public.toolbox_announcements','SELECT') as anonymous_read,
  has_table_privilege('authenticated','public.toolbox_announcements','INSERT,UPDATE,DELETE') as direct_write,
  has_function_privilege('anon','public.add_toolbox_announcement(uuid,text)','EXECUTE') as anonymous_add,
  has_function_privilege('authenticated','public.add_toolbox_announcement(uuid,text)','EXECUTE') as authenticated_add_rpc,
  has_function_privilege('authenticated','public.remove_toolbox_announcement(uuid,uuid)','EXECUTE') as authenticated_remove_rpc;
