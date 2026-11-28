-- 016A: Additional album directory. The legacy public archive stays read-only.
begin;
create table public.toolbox_albums (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete restrict,
  album_url text not null check (
    length(album_url) <= 2048 and
    album_url ~ '^https://(photos[.]app[.]goo[.]gl/[A-Za-z0-9_-]+|goo[.]gl/photos/[A-Za-z0-9_-]+|photos[.]google[.]com/share/[A-Za-z0-9_-]+([?]key=[A-Za-z0-9_-]+)?)$'
  ),
  title text not null check (length(btrim(title)) between 1 and 240),
  event_month text check (event_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  category text not null default 'Special Events' check (category in (
    'Camping','Courts of Honor','Community Service','Summer Camp','Camporees',
    'High Adventure','Special Events','Troop Meetings','Eagle Projects','Fundraising',
    'Crossovers','Hiking & Backpacking','Water Activities','Winter Activities','Training & Skills'
  )),
  cover_url text check (length(cover_url) <= 4096 and
    cover_url ~ '^https://lh[3-6][.]googleusercontent[.]com/[^[:space:]]+$'),
  created_at timestamptz not null default now(),
  unique(unit_id,album_url)
);
alter table public.toolbox_albums enable row level security;
revoke all on public.toolbox_albums from public, anon, authenticated;

create function toolbox_private.can_read_album_archive(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.member_accounts ma
    join public.members m on m.unit_id=ma.unit_id and m.id=ma.member_id
    join public.user_roles ur on ur.unit_id=ma.unit_id and ur.profile_id=ma.profile_id
    where ma.profile_id=(select auth.uid()) and ma.unit_id=p_unit_id and m.active
      and ((m.member_type='adult' and ur.role_code in ('admin','leader','parent'))
        or (m.member_type='youth' and ur.role_code='scout'))
  );
$$;
revoke all on function toolbox_private.can_read_album_archive(uuid) from public, anon, authenticated;
grant execute on function toolbox_private.can_read_album_archive(uuid) to authenticated;
create policy albums_read_member on public.toolbox_albums for select to authenticated
  using (toolbox_private.can_read_album_archive(unit_id));
grant select on public.toolbox_albums to authenticated;

create function public.can_manage_toolbox_albums(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and toolbox_private.has_staff_access(p_unit_id,true);
$$;
revoke all on function public.can_manage_toolbox_albums(uuid) from public, anon, authenticated;
grant execute on function public.can_manage_toolbox_albums(uuid) to authenticated;

create function public.add_toolbox_album(
  p_unit_id uuid, p_album_url text, p_title text, p_event_month text,
  p_category text, p_cover_url text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id,true) then
    raise exception 'Administrator access required';
  end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  insert into public.toolbox_albums(unit_id,album_url,title,event_month,category,cover_url)
  values(p_unit_id,btrim(p_album_url),btrim(p_title),nullif(btrim(p_event_month),''),
    p_category,nullif(btrim(p_cover_url),''))
  returning id into v_id;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,auth.uid(),'album.created','album',v_id);
  return v_id;
end;
$$;
revoke all on function public.add_toolbox_album(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.add_toolbox_album(uuid,text,text,text,text,text) to authenticated;
commit;
select
  has_table_privilege('anon','public.toolbox_albums','SELECT') as anon_can_read,
  has_table_privilege('authenticated','public.toolbox_albums','SELECT') as authenticated_can_read,
  has_table_privilege('authenticated','public.toolbox_albums','INSERT,UPDATE,DELETE,TRUNCATE') as authenticated_can_write,
  has_function_privilege('anon','public.add_toolbox_album(uuid,text,text,text,text,text)','EXECUTE') as anon_can_add;
