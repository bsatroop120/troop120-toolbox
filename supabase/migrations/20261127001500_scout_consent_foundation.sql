-- 015A: Development-only Scout consent record foundation.
-- This migration DOES NOT enable Scout sign-in or role assignment.
-- Records are fictional workflow tests, not legally verified consent.
begin;

create table toolbox_private.scout_consent_events (
    id uuid primary key default gen_random_uuid(),
    unit_id uuid not null,
    scout_member_id uuid not null,
    adult_member_id uuid not null,
    scout_type text not null default 'youth' check (scout_type = 'youth'),
    adult_type text not null default 'adult' check (adult_type = 'adult'),
    decision text not null check (decision in ('confirmed','withdrawn')),
    notice_version text not null check (notice_version = 'development-preview-v1'),
    recorded_by uuid not null,
    recorded_at timestamptz not null default clock_timestamp(),
    foreign key (unit_id, scout_member_id, scout_type)
        references public.members(unit_id,id,member_type) on delete restrict,
    foreign key (unit_id, adult_member_id, adult_type)
        references public.members(unit_id,id,member_type) on delete restrict
);

create index scout_consent_events_lookup_idx
    on toolbox_private.scout_consent_events(unit_id,scout_member_id,recorded_at desc,id);

alter table toolbox_private.scout_consent_events enable row level security;
revoke all on table toolbox_private.scout_consent_events
    from public,anon,authenticated;

-- Administrator records a FICTIONAL, independently confirmed guardian decision.
-- The existing backend Scout-role gate remains in force.
create function public.record_toolbox_test_scout_consent(
    p_unit_id uuid, p_scout_member_id uuid, p_adult_member_id uuid,
    p_confirmed boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := auth.uid();
    v_event uuid;
begin
    if v_actor is null or not toolbox_private.has_staff_access(p_unit_id,true) then
        raise exception 'Administrator access required';
    end if;
    perform toolbox_private.lock_family_lifecycle(p_unit_id);

    if p_confirmed is null then raise exception 'Consent decision required'; end if;

    if not exists (
        select 1 from public.members
        where unit_id=p_unit_id and id=p_scout_member_id and member_type='youth'
          and (active or not p_confirmed)
    ) then raise exception 'Select an eligible Scout in this unit'; end if;

    if not exists (
        select 1 from public.members
        where unit_id=p_unit_id and id=p_adult_member_id and member_type='adult'
          and (active or not p_confirmed)
    ) then raise exception 'Select an eligible adult in this unit'; end if;

    if p_confirmed and not exists (
        select 1 from public.family_relationships
        where unit_id=p_unit_id and scout_member_id=p_scout_member_id
          and adult_member_id=p_adult_member_id
    ) then raise exception 'Verified family relationship required'; end if;

    -- Withdrawal can be recorded for a previously confirmed pair even if
    -- the relationship has since been removed or either member deactivated.
    if not p_confirmed and not exists (
        select 1 from toolbox_private.scout_consent_events
        where unit_id=p_unit_id and scout_member_id=p_scout_member_id
          and adult_member_id=p_adult_member_id and decision='confirmed'
    ) then raise exception 'No prior test consent for this relationship'; end if;

    insert into toolbox_private.scout_consent_events
        (unit_id,scout_member_id,adult_member_id,decision,notice_version,recorded_by)
    values (p_unit_id,p_scout_member_id,p_adult_member_id,
        case when p_confirmed then 'confirmed' else 'withdrawn' end,
        'development-preview-v1',v_actor)
    returning id into v_event;

    insert into public.audit_logs
        (unit_id,actor_profile_id,action,entity_type,entity_id,details)
    values (p_unit_id,v_actor,
        case when p_confirmed then 'consent.test_confirmed' else 'consent.test_withdrawn' end,
        'member',p_scout_member_id,
        jsonb_build_object('consent_event_id',v_event,'adult_member_id',p_adult_member_id,
                           'notice_version','development-preview-v1'));

    -- No access is granted here. Defensive removal on withdrawal.
    if not p_confirmed then
        delete from public.user_roles ur using public.member_accounts ma
        where ma.unit_id=p_unit_id and ma.member_id=p_scout_member_id
          and ur.unit_id=ma.unit_id and ur.profile_id=ma.profile_id
          and ur.role_code='scout';
        if found then
            insert into public.audit_logs
                (unit_id,actor_profile_id,action,entity_type,entity_id,details)
            values (p_unit_id,v_actor,'role.revoked.scout','member',p_scout_member_id,
                jsonb_build_object('reason','test_consent_withdrawn'));
        end if;
    end if;
    return v_event;
end;
$$;
revoke all on function public.record_toolbox_test_scout_consent(uuid,uuid,uuid,boolean)
    from public,anon,authenticated;
grant execute on function public.record_toolbox_test_scout_consent(uuid,uuid,uuid,boolean)
    to authenticated;

commit;

select c.relrowsecurity as consent_rls_enabled,
    has_table_privilege('anon',c.oid,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as anon_table_access,
    has_table_privilege('authenticated',c.oid,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as authenticated_table_access,
    p.prosecdef as security_definer,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute
from pg_catalog.pg_class c
cross join pg_catalog.pg_proc p
where c.oid='toolbox_private.scout_consent_events'::regclass
  and p.oid='public.record_toolbox_test_scout_consent(uuid,uuid,uuid,boolean)'::regprocedure;
