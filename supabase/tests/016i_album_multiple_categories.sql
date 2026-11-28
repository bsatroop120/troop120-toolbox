-- 016I: Multiple album categories, permission checks and regression tests. Rollback only.
begin;
do $$
declare
 v_unit uuid; v_other uuid; v_admin uuid; v_user uuid; v_member uuid; v_child uuid; v_foreign uuid;
 v_parent uuid:=gen_random_uuid(); v_leader uuid:=gen_random_uuid(); v_pending uuid:=gen_random_uuid();
begin
 select id into strict v_unit from public.units where slug='troop-120';
 select profile_id into strict v_admin from public.user_roles where unit_id=v_unit and role_code='admin';
 insert into public.units(name,slug) values ('Album test other unit','test-'||gen_random_uuid()::text) returning id into v_other;
 insert into public.toolbox_albums(unit_id,album_url,title,category,categories) values(v_other,'https://photos.app.goo.gl/TestOtherUnit','Test foreign album','Special Events',array['Special Events']) returning id into v_foreign;
 foreach v_user in array array[v_parent,v_leader,v_pending] loop
   insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
   values(v_user,'authenticated','authenticated',v_user::text||'@example.invalid',now(),now(),now(),'{}','{}');
   insert into public.profiles(id,display_name) values(v_user,'Album Test Account') on conflict(id) do nothing;
   if v_user<>v_pending then
     insert into public.members(unit_id,display_name,member_type) values(v_unit,'Album Test Adult','adult') returning id into v_member;
     insert into public.member_accounts(unit_id,profile_id,member_id) values(v_unit,v_user,v_member);
     insert into public.user_roles(unit_id,profile_id,role_code) values(v_unit,v_user,case when v_user=v_parent then 'parent' else 'leader' end);
     if v_user=v_parent then
       insert into public.members(unit_id,display_name,member_type) values(v_unit,'Album Test Scout','youth') returning id into v_child;
       insert into public.family_relationships(unit_id,adult_member_id,scout_member_id,relationship_type) values(v_unit,v_member,v_child,'guardian');
     end if;
   end if;
 end loop;
 perform set_config('toolbox.test_unit',v_unit::text,true);
 perform set_config('toolbox.test_other',v_other::text,true);
 perform set_config('toolbox.test_foreign_album',v_foreign::text,true);
 perform set_config('toolbox.test_admin',v_admin::text,true);
 perform set_config('toolbox.test_parent',v_parent::text,true);
 perform set_config('toolbox.test_leader',v_leader::text,true);
 perform set_config('toolbox.test_pending',v_pending::text,true);
end $$;
set local role authenticated;
do $$
declare
 v_unit uuid:=current_setting('toolbox.test_unit')::uuid;
 v_other uuid:=current_setting('toolbox.test_other')::uuid;
 v_admin uuid:=current_setting('toolbox.test_admin')::uuid;
 v_parent uuid:=current_setting('toolbox.test_parent')::uuid;
 v_leader uuid:=current_setting('toolbox.test_leader')::uuid;
 v_pending uuid:=current_setting('toolbox.test_pending')::uuid;
 v_user uuid; v_id uuid; v_denied boolean; v_invalid text[]; v_updated timestamptz; v_new_updated timestamptz;
 v_foreign uuid:=current_setting('toolbox.test_foreign_album')::uuid;
 v_url text:='https://photos.app.goo.gl/TestAlbum'||replace(gen_random_uuid()::text,'-','');
begin
 if has_table_privilege('anon','public.toolbox_albums','SELECT') or
    has_table_privilege('authenticated','public.toolbox_albums','INSERT,UPDATE,DELETE,TRUNCATE') or
    has_function_privilege('anon','public.add_toolbox_album_categories(uuid,text,text,text,text[],text)','EXECUTE')
 or has_function_privilege('anon','public.update_toolbox_album_categories(uuid,uuid,timestamptz,text,text,text,text[],text)','EXECUTE')
 or has_function_privilege('anon','public.remove_toolbox_album(uuid,uuid,timestamptz)','EXECUTE')
 then raise exception 'FAIL: album permissions'; end if;
 if has_function_privilege('authenticated','public.add_toolbox_album(uuid,text,text,text,text,text)','EXECUTE') or has_function_privilege('authenticated','public.update_toolbox_album(uuid,uuid,timestamptz,text,text,text,text,text)','EXECUTE') then raise exception 'FAIL: old single-category writes still enabled'; end if;
 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
 if not public.can_manage_toolbox_albums(v_unit) or public.can_manage_toolbox_albums(v_other) then raise exception 'FAIL: admin unit check'; end if;
 v_id:=public.add_toolbox_album_categories(v_unit,v_url,'Test Album','2026-11',array['Camping','Fundraising'],null);
 if not exists(select 1 from public.toolbox_albums where id=v_id and categories=array['Camping','Fundraising'] and category='Camping') then raise exception 'FAIL: both initial categories not saved'; end if;
 if not exists(select 1 from public.toolbox_albums where id=v_id) then raise exception 'FAIL: admin cannot read own unit album'; end if;
 if exists(select 1 from public.toolbox_albums where unit_id=v_other) then raise exception 'FAIL: foreign album leak'; end if;
 if not exists(select 1 from public.audit_logs where action='album.created' and entity_id=v_id) then raise exception 'FAIL: audit missing'; end if;
 v_denied:=false;
 begin perform public.add_toolbox_album_categories(v_unit,v_url,'Duplicate',null,array['Camping'],null);
 exception when unique_violation then v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: duplicate accepted'; end if;
 v_denied:=false;
 begin perform public.add_toolbox_album_categories(v_unit,'https://example.invalid/album','Bad link',null,array['Camping'],null);
 exception when check_violation then v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: invalid link accepted'; end if;
 select updated_at into strict v_updated from public.toolbox_albums where id=v_id;
 for v_invalid in select x from (values (array[]::text[]),(array['Camping','Camping']::text[]),(array['Invalid']::text[]),(array['Camping',null]::text[]),(null::text[])) as t(x) loop
   v_denied:=false;
   begin perform public.update_toolbox_album_categories(v_unit,v_id,v_updated,v_url,'Invalid',null,v_invalid,null);
   exception when raise_exception then if sqlerrm<>'Select one or more valid, unique album categories' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: invalid categories accepted'; end if;
 end loop;
 perform public.update_toolbox_album_categories(v_unit,v_id,v_updated,v_url,'Updated Album','2025-04',array['Training & Skills','Camping'],null);
 select updated_at into strict v_new_updated from public.toolbox_albums where id=v_id and title='Updated Album' and event_month='2025-04' and category='Training & Skills' and categories=array['Training & Skills','Camping'];
 if v_updated=v_new_updated then raise exception 'FAIL: version unchanged'; end if;
 if not exists(select 1 from public.audit_logs where action='album.updated' and entity_id=v_id) then raise exception 'FAIL: edit audit missing'; end if;
 v_denied:=false;
 begin perform public.remove_toolbox_album(v_unit,v_id,v_updated);
 exception when raise_exception then if sqlerrm<>'Album changed or unavailable; refresh and try again' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: stale removal accepted'; end if;
 v_denied:=false;
 begin perform public.update_toolbox_album_categories(v_unit,v_foreign,v_new_updated,v_url,'Denied',null,array['Camping'],null);
 exception when raise_exception then if sqlerrm<>'Album changed or unavailable; refresh and try again' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: foreign edit accepted'; end if;
 v_denied:=false;
 begin perform public.remove_toolbox_album(v_other,v_foreign,v_new_updated);
 exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: foreign remove accepted'; end if;
 foreach v_user in array array[v_parent,v_leader,v_pending] loop
   perform set_config('request.jwt.claim.sub',v_user::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
   if public.can_manage_toolbox_albums(v_unit) then raise exception 'FAIL: non-admin can manage'; end if;
   if (exists(select 1 from public.toolbox_albums where id=v_id)) <> (v_user<>v_pending) then raise exception 'FAIL: member read policy'; end if;
   if exists(select 1 from public.toolbox_albums where unit_id=v_other) then raise exception 'FAIL: foreign album leak'; end if;
   v_denied:=false;
   begin perform public.add_toolbox_album_categories(v_unit,v_url||'x','Denied',null,array['Camping'],null);
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin add'; end if;
   v_denied:=false;
   begin perform public.update_toolbox_album_categories(v_unit,v_id,v_new_updated,v_url,'Denied',null,array['Camping'],null);
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin edit'; end if;
   v_denied:=false;
   begin perform public.remove_toolbox_album(v_unit,v_id,v_new_updated);
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin remove'; end if;
 end loop;
 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
 perform public.remove_toolbox_album(v_unit,v_id,v_new_updated);
 if exists(select 1 from public.toolbox_albums where id=v_id) then raise exception 'FAIL: removal did not persist'; end if;
 if not exists(select 1 from public.audit_logs where action='album.removed' and entity_id=v_id) then raise exception 'FAIL: removal audit missing'; end if;
end $$;
reset role;
rollback;
select 'PASS: multiple album categories, validation, legacy write protection, admin-only access, unit isolation and audit' as result;
