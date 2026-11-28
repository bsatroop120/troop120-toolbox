-- 016L: Category catalog security and cascading rename tests. Rollback only.
begin;
do $$
declare
 v_unit uuid; v_other uuid; v_admin uuid; v_user uuid; v_member uuid; v_child uuid; v_foreign uuid;
 v_parent uuid:=gen_random_uuid(); v_leader uuid:=gen_random_uuid(); v_pending uuid:=gen_random_uuid();
begin
 select id into strict v_unit from public.units where slug='troop-120';
 select profile_id into strict v_admin from public.user_roles where unit_id=v_unit and role_code='admin';
 insert into public.units(name,slug) values ('Album test other unit','test-'||gen_random_uuid()::text) returning id into v_other;
 insert into public.toolbox_album_categories(unit_id,name) values(v_other,'Special Events'),(v_other,'Test Foreign Category');
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
 v_user uuid; v_category uuid; v_album uuid; v_denied boolean; v_before timestamptz;
 v_name text:='Test Category '||gen_random_uuid()::text;
 v_new text:='Renamed '||gen_random_uuid()::text;
 v_url text:='https://photos.app.goo.gl/TestAlbum'||replace(gen_random_uuid()::text,'-','');
 v_base text;
begin
 if has_table_privilege('anon','public.toolbox_album_categories','SELECT')
 or has_table_privilege('authenticated','public.toolbox_album_categories','INSERT,UPDATE,DELETE,TRUNCATE')
 or has_function_privilege('anon','public.create_toolbox_album_category(uuid,text)','EXECUTE')
 or has_function_privilege('anon','public.rename_toolbox_album_category(uuid,uuid,text,text)','EXECUTE')
 then raise exception 'FAIL: category permissions'; end if;

 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
 select name into strict v_base from public.toolbox_album_categories where unit_id=v_unit order by name limit 1;
 v_category:=public.create_toolbox_album_category(v_unit,v_name);
 if not exists(select 1 from public.toolbox_album_categories where id=v_category and name=v_name) then raise exception 'FAIL: create category'; end if;
 v_denied:=false;
 begin perform public.create_toolbox_album_category(v_unit,upper(v_name));
 exception when unique_violation then v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: duplicate category'; end if;
 v_denied:=false;
 begin perform public.add_toolbox_album_categories(v_unit,v_url,'Foreign category',null,array['Test Foreign Category'],null);
 exception when raise_exception then if sqlerrm<>'Select categories from this unit' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: foreign category accepted'; end if;

 v_album:=public.add_toolbox_album_categories(v_unit,v_url,'Test album','2025-04',array[v_name,v_base],null);
 select updated_at into strict v_before from public.toolbox_albums where id=v_album;
 perform public.rename_toolbox_album_category(v_unit,v_category,v_name,v_new);
 if not exists(select 1 from public.toolbox_album_categories where id=v_category and name=v_new) then raise exception 'FAIL: rename category'; end if;
 if not exists(select 1 from public.toolbox_albums where id=v_album and category=v_new and categories=array[v_new,v_base] and updated_at<>v_before and event_month='2025-04') then raise exception 'FAIL: rename propagation'; end if;
 if (select count(*) from public.audit_logs where entity_id=v_category and action in ('album_category.created','album_category.renamed'))<>2 then raise exception 'FAIL: category audit'; end if;
 v_denied:=false;
 begin perform public.rename_toolbox_album_category(v_unit,v_category,v_name,'Stale rename');
 exception when raise_exception then if sqlerrm<>'Category changed or unavailable; refresh and try again' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: stale rename accepted'; end if;
 v_denied:=false;
 begin perform public.rename_toolbox_album_category(v_other,v_category,v_new,'Foreign rename');
 exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: cross-unit rename'; end if;
 if exists(select 1 from public.toolbox_album_categories where unit_id=v_other) then raise exception 'FAIL: cross-unit read'; end if;

 foreach v_user in array array[v_parent,v_leader,v_pending] loop
   perform set_config('request.jwt.claim.sub',v_user::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
   if (exists(select 1 from public.toolbox_album_categories where id=v_category))<>(v_user<>v_pending) then raise exception 'FAIL: member category read policy'; end if;
   if exists(select 1 from public.toolbox_album_categories where unit_id=v_other) then raise exception 'FAIL: category isolation'; end if;
   v_denied:=false;
   begin perform public.create_toolbox_album_category(v_unit,'Denied');
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin create'; end if;
   v_denied:=false;
   begin perform public.rename_toolbox_album_category(v_unit,v_category,v_new,'Denied');
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin rename'; end if;
 end loop;
end $$;
reset role;
rollback;
select 'PASS: admin-only category creation and rename, album propagation, duplicate prevention, unit isolation, stale-write protection and audit' as result;
