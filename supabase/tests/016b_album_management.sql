-- 016B: Album permissions and unit isolation. Rollback only.
begin;
do $$
declare
 v_unit uuid; v_other uuid; v_admin uuid; v_user uuid; v_member uuid; v_child uuid;
 v_parent uuid:=gen_random_uuid(); v_leader uuid:=gen_random_uuid(); v_pending uuid:=gen_random_uuid();
begin
 select id into strict v_unit from public.units where slug='troop-120';
 select profile_id into strict v_admin from public.user_roles where unit_id=v_unit and role_code='admin';
 insert into public.units(name,slug) values ('Album test other unit','test-'||gen_random_uuid()::text) returning id into v_other;
 insert into public.toolbox_albums(unit_id,album_url,title) values(v_other,'https://photos.app.goo.gl/TestOtherUnit','Test foreign album');
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
 v_user uuid; v_id uuid; v_denied boolean;
 v_url text:='https://photos.app.goo.gl/TestAlbum'||replace(gen_random_uuid()::text,'-','');
begin
 if has_table_privilege('anon','public.toolbox_albums','SELECT') or
    has_table_privilege('authenticated','public.toolbox_albums','INSERT,UPDATE,DELETE,TRUNCATE') or
    has_function_privilege('anon','public.add_toolbox_album(uuid,text,text,text,text,text)','EXECUTE')
 then raise exception 'FAIL: album permissions'; end if;
 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
 if not public.can_manage_toolbox_albums(v_unit) or public.can_manage_toolbox_albums(v_other) then raise exception 'FAIL: admin unit check'; end if;
 v_id:=public.add_toolbox_album(v_unit,v_url,'Test Album','2026-11','Camping',null);
 if not exists(select 1 from public.toolbox_albums where id=v_id) then raise exception 'FAIL: admin cannot read own unit album'; end if;
 if exists(select 1 from public.toolbox_albums where unit_id=v_other) then raise exception 'FAIL: foreign album leak'; end if;
 if not exists(select 1 from public.audit_logs where action='album.created' and entity_id=v_id) then raise exception 'FAIL: audit missing'; end if;
 v_denied:=false;
 begin perform public.add_toolbox_album(v_unit,v_url,'Duplicate',null,'Camping',null);
 exception when unique_violation then v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: duplicate accepted'; end if;
 v_denied:=false;
 begin perform public.add_toolbox_album(v_unit,'https://example.invalid/album','Bad link',null,'Camping',null);
 exception when check_violation then v_denied:=true; end;
 if not v_denied then raise exception 'FAIL: invalid link accepted'; end if;
 foreach v_user in array array[v_parent,v_leader,v_pending] loop
   perform set_config('request.jwt.claim.sub',v_user::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated')::text,true);
   if public.can_manage_toolbox_albums(v_unit) then raise exception 'FAIL: non-admin can manage'; end if;
   if (exists(select 1 from public.toolbox_albums where id=v_id)) <> (v_user<>v_pending) then raise exception 'FAIL: member read policy'; end if;
   if exists(select 1 from public.toolbox_albums where unit_id=v_other) then raise exception 'FAIL: foreign album leak'; end if;
   v_denied:=false;
   begin perform public.add_toolbox_album(v_unit,v_url||'x','Denied',null,'Camping',null);
   exception when raise_exception then if sqlerrm<>'Administrator access required' then raise; end if; v_denied:=true; end;
   if not v_denied then raise exception 'FAIL: non-admin add'; end if;
 end loop;
end $$;
reset role;
rollback;
select 'PASS: administrator-only album addition, member read access, unit isolation, duplicate and URL checks, audit' as result;
