-- 016H: Multiple categories per photo album.
-- Preserve every existing album, its original category, date, cover and URL.
begin;

alter table public.toolbox_albums add column categories text[];
update public.toolbox_albums set categories=array[category];
alter table public.toolbox_albums alter column categories set not null;

create function toolbox_private.valid_album_categories(p_categories text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    array_ndims(p_categories)=1
    and array_lower(p_categories,1)=1
    and cardinality(p_categories) between 1 and 15
    and array_position(p_categories,null::text) is null
    and p_categories <@ array[
      'Camping','Courts of Honor','Community Service','Summer Camp','Camporees',
      'High Adventure','Special Events','Troop Meetings','Eagle Projects','Fundraising',
      'Crossovers','Hiking & Backpacking','Water Activities','Winter Activities','Training & Skills'
    ]::text[]
    and cardinality(p_categories)=(select count(distinct c) from unnest(p_categories) as t(c)),
    false
  );
$$;
revoke all on function toolbox_private.valid_album_categories(text[]) from public,anon,authenticated;

alter table public.toolbox_albums add constraint toolbox_albums_categories_check
  check (toolbox_private.valid_album_categories(categories) and category=categories[1]);

-- Change all version tokens to prevent stale pre-migration editors.
update public.toolbox_albums set updated_at=clock_timestamp();

create function public.add_toolbox_album_categories(
  p_unit_id uuid,p_album_url text,p_title text,p_event_month text,
  p_categories text[],p_cover_url text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id,true) then
    raise exception 'Administrator access required';
  end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if not toolbox_private.valid_album_categories(p_categories) then
    raise exception 'Select one or more valid, unique album categories';
  end if;
  insert into public.toolbox_albums(unit_id,album_url,title,event_month,category,categories,cover_url)
  values(p_unit_id,btrim(p_album_url),btrim(p_title),nullif(btrim(p_event_month),''),
    p_categories[1],p_categories,nullif(btrim(p_cover_url),''))
  returning id into v_id;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,auth.uid(),'album.created','album',v_id);
  return v_id;
end;
$$;

create function public.update_toolbox_album_categories(
  p_unit_id uuid,p_album_id uuid,p_expected_updated_at timestamptz,
  p_album_url text,p_title text,p_event_month text,p_categories text[],p_cover_url text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not toolbox_private.has_staff_access(p_unit_id,true) then
    raise exception 'Administrator access required';
  end if;
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if not toolbox_private.valid_album_categories(p_categories) then
    raise exception 'Select one or more valid, unique album categories';
  end if;
  update public.toolbox_albums
  set album_url=btrim(p_album_url),title=btrim(p_title),
    event_month=nullif(btrim(p_event_month),''),category=p_categories[1],
    categories=p_categories,cover_url=nullif(btrim(p_cover_url),''),updated_at=clock_timestamp()
  where id=p_album_id and unit_id=p_unit_id and updated_at=p_expected_updated_at;
  if not found then raise exception 'Album changed or unavailable; refresh and try again'; end if;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,auth.uid(),'album.updated','album',p_album_id);
end;
$$;

revoke all on function public.add_toolbox_album_categories(uuid,text,text,text,text[],text) from public,anon,authenticated;
revoke all on function public.update_toolbox_album_categories(uuid,uuid,timestamptz,text,text,text,text[],text) from public,anon,authenticated;
grant execute on function public.add_toolbox_album_categories(uuid,text,text,text,text[],text) to authenticated;
grant execute on function public.update_toolbox_album_categories(uuid,uuid,timestamptz,text,text,text,text[],text) to authenticated;

-- Disable the old single-category writes so cached clients cannot erase extra categories.
-- The legacy category column remains for backward-compatible reads only.
revoke all on function public.add_toolbox_album(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.update_toolbox_album(uuid,uuid,timestamptz,text,text,text,text,text) from public,anon,authenticated;
commit;

select count(*) as total_albums,
  count(*) filter(where cardinality(a.categories)>=1) as albums_with_categories,
  count(*) filter(where cardinality(a.categories)>1) as multi_category_albums
from public.toolbox_albums a join public.units u on u.id=a.unit_id
where u.slug='troop-120';
