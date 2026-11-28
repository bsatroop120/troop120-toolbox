-- 019D: Shared 15-minute BAND cache, with a server-only refresh lease.
begin;

create table toolbox_private.band_refresh_state (
  unit_id uuid primary key references public.units(id) on delete restrict,
  lease_id uuid,
  actor_id uuid,
  lease_until timestamptz,
  retry_after timestamptz
);
alter table toolbox_private.band_refresh_state enable row level security;
revoke all on toolbox_private.band_refresh_state from public, anon, authenticated, service_role;

-- Match the existing active-member archive policy; forced refresh is adult admin only.
create function toolbox_private.band_actor_allowed(
  p_unit_id uuid, p_actor_id uuid, p_force boolean
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_force is not null and exists (
    select 1 from public.units u
    join public.member_accounts ma on ma.unit_id=u.id
    join public.members m on m.unit_id=ma.unit_id and m.id=ma.member_id
    join public.user_roles ur on ur.unit_id=ma.unit_id and ur.profile_id=ma.profile_id
    where u.id=p_unit_id and u.slug='troop-120'
      and ma.profile_id=p_actor_id and m.active
      and (
        (m.member_type='adult' and
          (ur.role_code='admin' or
            (not p_force and ur.role_code in ('leader','parent'))))
        or (not p_force and m.member_type='youth' and ur.role_code='scout')
      )
  );
$$;
revoke all on function toolbox_private.band_actor_allowed(uuid,uuid,boolean)
  from public, anon, authenticated, service_role;

create function public.claim_toolbox_band_refresh(
  p_unit_id uuid, p_actor_id uuid, p_force boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_state toolbox_private.band_refresh_state%rowtype;
  v_last timestamptz;
  v_now timestamptz;
  v_lease uuid;
begin
  if not toolbox_private.band_actor_allowed(p_unit_id,p_actor_id,p_force) then
    return jsonb_build_object('status','denied');
  end if;
  perform 1 from public.units where id=p_unit_id for no key update;
  if not toolbox_private.band_actor_allowed(p_unit_id,p_actor_id,p_force) then
    return jsonb_build_object('status','denied');
  end if;
  v_now:=clock_timestamp();
  select refreshed_at into v_last from public.toolbox_band_events where unit_id=p_unit_id;
  if not p_force and v_last > v_now-interval '15 minutes' then
    return jsonb_build_object('status','cached','refreshed_at',v_last);
  end if;
  select * into v_state from toolbox_private.band_refresh_state where unit_id=p_unit_id;
  if v_state.lease_until > v_now then
    return jsonb_build_object('status','busy','refreshed_at',v_last);
  end if;
  if not p_force and v_state.retry_after > v_now then
    return jsonb_build_object('status','backoff','refreshed_at',v_last);
  end if;
  v_lease:=gen_random_uuid();
  insert into toolbox_private.band_refresh_state(unit_id,lease_id,actor_id,lease_until,retry_after)
  values(p_unit_id,v_lease,p_actor_id,v_now+interval '90 seconds',v_now+interval '2 minutes')
  on conflict(unit_id) do update set lease_id=excluded.lease_id,
    actor_id=excluded.actor_id,lease_until=excluded.lease_until,retry_after=excluded.retry_after;
  return jsonb_build_object('status','claimed','lease_id',v_lease);
end;
$$;
revoke all on function public.claim_toolbox_band_refresh(uuid,uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_toolbox_band_refresh(uuid,uuid,boolean) to service_role;

-- Close a valid lease. A NULL payload records a failed attempt, retaining old events.
-- Remove the original write entry point so old workers cannot bypass the lease.
drop function public.save_toolbox_band_events_snapshot(uuid,uuid,jsonb,timestamptz);

create function public.finish_toolbox_band_refresh(
  p_unit_id uuid, p_actor_id uuid, p_lease_id uuid, p_force boolean, p_events jsonb
)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare
  v_state toolbox_private.band_refresh_state%rowtype;
  v_refreshed timestamptz;
begin
  perform 1 from public.units where id=p_unit_id for no key update;
  select * into v_state from toolbox_private.band_refresh_state where unit_id=p_unit_id;
  if p_lease_id is null or p_actor_id is null or v_state.lease_id is distinct from p_lease_id
    or v_state.actor_id is distinct from p_actor_id
    or v_state.lease_until is null or v_state.lease_until <= clock_timestamp()
  then raise exception 'Refresh lease expired or changed'; end if;
  if p_events is not null and toolbox_private.band_actor_allowed(p_unit_id,p_actor_id,p_force) then
    insert into public.toolbox_band_events(unit_id,events,refreshed_at)
    values(p_unit_id,p_events,clock_timestamp())
    on conflict(unit_id) do update set events=excluded.events,refreshed_at=excluded.refreshed_at
    returning refreshed_at into v_refreshed;
    insert into public.audit_logs(unit_id,actor_profile_id,action,entity_type,entity_id)
    values(p_unit_id,p_actor_id,'band_events.refreshed','band_events',p_unit_id);
  end if;
  update toolbox_private.band_refresh_state set lease_id=null,actor_id=null,lease_until=null,
    retry_after=case when v_refreshed is null then clock_timestamp()+interval '2 minutes' else null end
  where unit_id=p_unit_id;
  return v_refreshed;
end;
$$;
revoke all on function public.finish_toolbox_band_refresh(uuid,uuid,uuid,boolean,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_toolbox_band_refresh(uuid,uuid,uuid,boolean,jsonb) to service_role;

commit;

select
  has_function_privilege('authenticated','public.claim_toolbox_band_refresh(uuid,uuid,boolean)','EXECUTE') as client_claim,
  has_function_privilege('service_role','public.claim_toolbox_band_refresh(uuid,uuid,boolean)','EXECUTE') as server_claim,
  has_function_privilege('authenticated','public.finish_toolbox_band_refresh(uuid,uuid,uuid,boolean,jsonb)','EXECUTE') as client_finish,
  has_function_privilege('service_role','public.finish_toolbox_band_refresh(uuid,uuid,uuid,boolean,jsonb)','EXECUTE') as server_finish,
  (select count(*) from public.toolbox_band_events) as preserved_snapshots;
