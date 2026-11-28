-- 016K: Administrator-managed, unit-scoped album categories.
-- Keep existing category assignments. Renaming a category updates all its albums.
begin;
create table public.toolbox_album_categories (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete restrict,
  name text not null check (name=btrim(name) and length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
  unique(unit_id,name)
);
create unique index toolbox_album_categories_name_ci
  on public.toolbox_album_categories(unit_id,lower(name));
alter table public.toolbox_album_categories enable row level security;
revoke all on public.toolbox_album_categories from public,anon,authenticated;
grant select on public.toolbox_album_categories to authenticated;
create policy album_categories_read_member on public.toolbox_album_categories
  for select to authenticated using (toolbox_private.can_read_album_archive(unit_id));

-- Seed original choices for existing units, including unused choices.
insert into public.toolbox_album_categories(unit_id,name)
select u.id,n.name from public.units u
cross join unnest(array[
  'Camping','Courts of Honor','Community Service','Summer Camp','Camporees',
  'High Adventure','Special Events','Troop Meetings','Eagle Projects','Fundraising',
  'Crossovers','Hiking & Backpacking','Water Activities','Winter Activities','Training & Skills'
]::text[]) n(name);

-- The list is no longer fixed. Keep structural checks in the existing helper.
create or replace function toolbox_private.valid_album_categories(p_categories text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    array_ndims(p_categories)=1 and array_lower(p_categories,1)=1
    and cardinality(p_categories) between 1 and 15
    and array_position(p_categories,null::text) is null
    and cardinality(p_categories)=(select count(distinct c) from unnest(p_categories) as t(c)),
    false
  );
$$;
alter table public.toolbox_albums drop constraint toolbox_albums_category_check;
-- A trigger enforces the per-unit catalog for all writes, including existing RPCs.
create function toolbox_private.check_album_category_registry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from unnest(new.categories) t(name)
    where not exists (
      select 1 from public.toolbox_album_categories c
      where c.unit_id=new.unit_id and c.name=t.name
    )
  ) then
    raise exception 'Select categories from this unit';
  end if;
  return new;
end;
$$;
revoke all on function toolbox_private.check_album_category_registry() from public,anon,authenticated;
create trigger toolbox_albums_category_registry_check
  before insert or update of categories,unit_id on public.toolbox_albums
  for each row execute function toolbox_private.check_album_category_registry();

create function public.create_toolbox_album_category(p_unit_id uuid,p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text:=btrim(p_name);
begin
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if v_name is null or length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a category name of 1 to 60 characters';
  end if;
  if (select count(*) from public.toolbox_album_categories where unit_id=p_unit_id)>=100 then
    raise exception 'Maximum of 100 categories per unit';
  end if;
  insert into public.toolbox_album_categories(unit_id,name) values(p_unit_id,v_name)
  returning id into v_id;
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,auth.uid(),'album_category.created','album_category',v_id);
  return v_id;
end;
$$;

create function public.rename_toolbox_album_category(
  p_unit_id uuid,p_category_id uuid,p_expected_name text,p_name text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text; v_name text:=btrim(p_name);
begin
  perform toolbox_private.lock_family_lifecycle(p_unit_id);
  if v_name is null or length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a category name of 1 to 60 characters';
  end if;
  select name into v_old from public.toolbox_album_categories
  where unit_id=p_unit_id and id=p_category_id for update;
  if not found or v_old is distinct from p_expected_name then
    raise exception 'Category changed or unavailable; refresh and try again';
  end if;
  if v_name=v_old then return; end if;
  update public.toolbox_album_categories set name=v_name
  where unit_id=p_unit_id and id=p_category_id;
  update public.toolbox_albums
  set categories=array_replace(categories,v_old,v_name),
      category=case when category=v_old then v_name else category end,
      updated_at=clock_timestamp()
  where unit_id=p_unit_id and v_old=any(categories);
  insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
  values(p_unit_id,auth.uid(),'album_category.renamed','album_category',p_category_id);
end;
$$;
revoke all on function public.create_toolbox_album_category(uuid,text) from public,anon,authenticated;
revoke all on function public.rename_toolbox_album_category(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_toolbox_album_category(uuid,text) to authenticated;
grant execute on function public.rename_toolbox_album_category(uuid,uuid,text,text) to authenticated;

-- Verify all existing assignments before committing.
do $$
begin
  if exists (
    select 1 from public.toolbox_albums a cross join lateral unnest(a.categories) t(name)
    where not exists(select 1 from public.toolbox_album_categories c where c.unit_id=a.unit_id and c.name=t.name)
  ) then raise exception 'Existing album category missing from registry'; end if;
end $$;
commit;

select
  (select count(*) from public.toolbox_album_categories c join public.units u on u.id=c.unit_id where u.slug='troop-120') as categories,
  (select count(*) from public.toolbox_albums a join public.units u on u.id=a.unit_id where u.slug='troop-120') as albums_preserved;
