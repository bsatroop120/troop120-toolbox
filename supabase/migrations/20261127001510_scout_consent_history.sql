-- 015C: Administrator-only access to fictional Scout consent history.
-- This does not authorize Scout accounts or establish legal consent.
begin;

create function public.list_toolbox_test_scout_consent(
    p_unit_id uuid,
    p_scout_member_id uuid,
    p_offset integer default 0
)
returns table (
    event_id uuid,
    adult_member_id uuid,
    adult_name text,
    decision text,
    notice_version text,
    recorded_at timestamptz,
    recorded_by uuid,
    currently_linked boolean,
    adult_active boolean,
    scout_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null
       or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
    if p_offset is null or p_offset < 0 then
        raise exception 'Invalid history offset';
    end if;
    if not exists (
        select 1 from public.members m
        where m.unit_id=p_unit_id and m.id=p_scout_member_id
          and m.member_type='youth'
    ) then
        raise exception 'Scout unavailable in this unit';
    end if;

    -- Historical events remain visible to admins after unlink/deactivation.
    -- Return only one Scout's history, never the full private consent table.
    -- A page contains at most 100 records; request subsequent pages as needed.
    return query
    select e.id, e.adult_member_id, a.display_name, e.decision,
           e.notice_version, e.recorded_at, e.recorded_by,
           exists (
               select 1 from public.family_relationships fr
               where fr.unit_id=e.unit_id
                 and fr.adult_member_id=e.adult_member_id
                 and fr.scout_member_id=e.scout_member_id
           ),
           a.active, s.active
    from toolbox_private.scout_consent_events e
    join public.members a
      on a.unit_id=e.unit_id and a.id=e.adult_member_id
    join public.members s
      on s.unit_id=e.unit_id and s.id=e.scout_member_id
    where e.unit_id=p_unit_id and e.scout_member_id=p_scout_member_id
    order by e.recorded_at desc,e.id desc
    limit 100 offset p_offset;
end;
$$;

revoke all on function public.list_toolbox_test_scout_consent(uuid,uuid,integer)
    from public,anon,authenticated;
grant execute on function public.list_toolbox_test_scout_consent(uuid,uuid,integer)
    to authenticated;

commit;

select p.proname as function_name,
    p.prosecdef as security_definer,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
    has_table_privilege('authenticated',c.oid,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as direct_table_access,
    c.relrowsecurity as consent_rls_enabled
from pg_catalog.pg_proc p
cross join pg_catalog.pg_class c
where p.oid='public.list_toolbox_test_scout_consent(uuid,uuid,integer)'::regprocedure
  and c.oid='toolbox_private.scout_consent_events'::regclass;
