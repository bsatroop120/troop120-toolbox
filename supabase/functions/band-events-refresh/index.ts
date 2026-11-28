// @ts-nocheck
// Read only the configured BAND iCalendar feed; never expose the subscription token.
import ICAL from "npm:ical.js@2.2.1";
const cors={"Access-Control-Allow-Origin":"https://bsatroop120.github.io","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
const safeFetch=(url,options={})=>fetch(url,{...options,redirect:"error",signal:AbortSignal.timeout(15000)});
const troopZone="America/New_York";
const formatters=new Map();
function wallTimeMs(t,zone){
  if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"numeric",second:"numeric",hourCycle:"h23"}));
  const naive=Date.UTC(t.year,t.month-1,t.day,t.hour||0,t.minute||0,t.second||0);
  let ms=naive;
  for(let i=0;i<4;i++){
    const p=Object.fromEntries(formatters.get(zone).formatToParts(new Date(ms)).filter(x=>x.type!=="literal").map(x=>[x.type,Number(x.value)]));
    const delta=naive-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    if(!delta)return ms;
    ms+=delta;
  }
  throw Error("Unresolvable local calendar time");
}
function toMs(t,property){
  if(!t||!Number.isInteger(t.year)||t.year<1900||t.year>2200)throw Error("Invalid event date");
  if(t.isDate)return wallTimeMs(t,troopZone);
  if(t.zone&&t.zone!==ICAL.Timezone.localTimezone)return t.toUnixTime()*1000;
  const zone=property?.getParameter("tzid")||troopZone;
  return wallTimeMs(t,zone);
}
async function readFeed(){
  const raw=Deno.env.get("BAND_CALENDAR_URL");
  if(!raw)throw Error("BAND calendar secret not configured");
  const u=new URL(raw.replace(/^webcal:/i,"https:"));
  const token=u.searchParams.get("token");
  if(u.origin!=="https://api.band.us"||u.pathname!=="/ical"||u.username||u.password||u.hash||!token||!/^[A-Za-z0-9_-]{10,512}$/.test(token)||Array.from(u.searchParams.keys()).join(",")!=="token")throw Error("Invalid BAND feed configuration");
  const endpoint="https://api.band.us/ical?token="+encodeURIComponent(token);
  const response=await safeFetch(endpoint,{headers:{Accept:"text/calendar"}});
  if(!response.ok||!response.body)throw Error("BAND feed unavailable");
  const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let body="",size=0;
  try{
    while(true){
      const chunk=await reader.read();if(chunk.done)break;
      size+=chunk.value.byteLength;if(size>2*1024*1024)throw Error("Calendar feed exceeds limit");
      body+=decoder.decode(chunk.value,{stream:true});
    }
    body+=decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
  return {body,token};
}
function parseFeed(body,token,now=Date.now()){
  if(!body.trimStart().startsWith("BEGIN:VCALENDAR")||!body.trimEnd().endsWith("END:VCALENDAR"))throw Error("Invalid iCalendar response");
  const calendar=new ICAL.Component(ICAL.parse(body));
  if(calendar.name!=="vcalendar"||String(calendar.getFirstPropertyValue("version"))!=="2.0")throw Error("Unsupported calendar format");
  if(String(calendar.getFirstPropertyValue("method")||"").toUpperCase()==="CANCEL")throw Error("Cancellation message is not a full calendar");
  ICAL.TimezoneService.reset();
  for(const zone of calendar.getAllSubcomponents("vtimezone")){
    const timezone=new ICAL.Timezone(zone);
    ICAL.TimezoneService.register(timezone);
  }
  const components=calendar.getAllSubcomponents("vevent");
  if(components.length>3000)throw Error("Calendar contains too many events");
  const events=[],seen=new Set(),horizon=now+548*86400000;
  const clean=(v,max)=>{
    const s=String(v??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
    if(s.includes(token)||/api\.band\.us\/ical\?/i.test(s))return "";
    return s.slice(0,max);
  };
  const cancelled=c=>String(c.getFirstPropertyValue("status")||"").toUpperCase()==="CANCELLED";
  const add=(c,start,end,master=c)=>{
    if(cancelled(c))return;
    const startProp=c.getFirstProperty("dtstart")||master.getFirstProperty("dtstart");
    const endProp=c.getFirstProperty("dtend")||master.getFirstProperty("dtend")||startProp;
    const s=toMs(start,startProp),e=end?toMs(end,endProp):s;
    if(!Number.isFinite(s)||!Number.isFinite(e)||e<s)throw Error("Invalid event range");
    if(s>horizon||(e>s?e<=now:s<now))return;
    const title=clean(c.getFirstPropertyValue("summary")??master.getFirstPropertyValue("summary"),240)||"Untitled event";
    const location=clean(c.getFirstPropertyValue("location")??master.getFirstPropertyValue("location"),300);
    const uid=String(master.getFirstPropertyValue("uid")||c.getFirstPropertyValue("uid")||"");
    const key=uid+"|"+s+"|"+e+"|"+title;
    if(seen.has(key))return;seen.add(key);
    events.push({title,location,starts_at:new Date(s).toISOString(),ends_at:new Date(e).toISOString(),all_day:!!start.isDate});
    if(events.length>1000)throw Error("Too many upcoming events");
  };
  const masters=new Map(),exceptions=new Map();
  for(const c of components){
    const uid=String(c.getFirstPropertyValue("uid")||"");
    if(!uid)throw Error("Event UID missing");
    if(c.hasProperty("recurrence-id")){
      if(c.getFirstProperty("recurrence-id").getParameter("range"))throw Error("Unsupported recurring range override");
      if(!exceptions.has(uid))exceptions.set(uid,[]);
      exceptions.get(uid).push(c);
    }else{
      if(masters.has(uid))throw Error("Duplicate event UID");
      masters.set(uid,c);
    }
  }
  let iterations=0;
  for(const [uid,c] of masters){
    if(cancelled(c))continue;
    const ev=new ICAL.Event(c,{exceptions:[],strictExceptions:true});
    if(!ev.startDate)throw Error("Event start missing");
    const overrides=exceptions.get(uid)||[];
    for(const x of overrides)ev.relateException(new ICAL.Event(x,{exceptions:[]}));
    if(ev.isRecurring()){
      const iterator=ev.iterator();
      let occurrence;
      while((occurrence=iterator.next())){
        if(++iterations>25000)throw Error("Recurrence expansion exceeds limit");
        if(toMs(occurrence,c.getFirstProperty("dtstart"))>horizon)break;
        const details=ev.getOccurrenceDetails(occurrence);
        if(details.item===ev)add(c,details.startDate,details.endDate);
      }
      for(const x of overrides){
        if(cancelled(x))continue;
        const override=new ICAL.Event(x,{exceptions:[]});
        add(x,override.startDate,override.endDate,c);
      }
    }else{
      if(overrides.length)throw Error("Unexpected recurrence override");
      add(c,ev.startDate,ev.endDate);
    }
  }
  for(const [uid,items] of exceptions)if(!masters.has(uid)){
    for(const c of items){
      if(cancelled(c))continue;
      const ev=new ICAL.Event(c,{exceptions:[]});
      add(c,ev.startDate,ev.endDate);
    }
  }
  return events.sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.title.localeCompare(b.title));
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="POST")return reply({error:"Method not allowed"},405);
  const bearer=req.headers.get("Authorization");
  if(!bearer?.startsWith("Bearer "))return reply({error:"Sign-in required"},401);
  let unit;
  try{
    const raw=await req.text();if(raw.length>1024)return reply({error:"Request too large"},413);
    unit=JSON.parse(raw).unit_id;
    if(typeof unit!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unit))throw Error();
  }catch{return reply({error:"Invalid request"},400);}
  const api=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!api||!anon||!service)return reply({error:"Refresh not configured"},503);
  const caller={Authorization:bearer,apikey:anon,"Content-Type":"application/json"};
  try{
    const user=await safeFetch(api+"/auth/v1/user",{headers:caller});
    if(!user.ok)return reply({error:"Sign-in required"},401);
    const actor=(await user.json()).id;
    if(typeof actor!=="string")return reply({error:"Sign-in required"},401);
    const allowed=await safeFetch(api+"/rest/v1/rpc/can_refresh_toolbox_band_events",{method:"POST",headers:caller,body:JSON.stringify({p_unit_id:unit})});
    if(!allowed.ok||await allowed.json()!==true)return reply({error:"Administrator access required"},403);
    const current=await safeFetch(api+"/rest/v1/toolbox_band_events?select=refreshed_at&unit_id=eq."+encodeURIComponent(unit),{headers:caller});
    if(!current.ok)return reply({error:"Events storage unavailable"},503);
    const rows=await current.json();
    if(!Array.isArray(rows)||rows.length>1)return reply({error:"Events storage unavailable"},503);
    let feed;
    try{feed=await readFeed();}catch{return reply({error:"Unable to retrieve the BAND calendar. Check the subscription URL in Supabase Secrets."},502);}
    let events;
    try{events=parseFeed(feed.body,feed.token);}catch{return reply({error:"BAND calendar format could not be fully imported. The previous snapshot is retained."},422);}
    const saved=await safeFetch(api+"/rest/v1/rpc/save_toolbox_band_events_snapshot",{method:"POST",headers:{Authorization:"Bearer "+service,apikey:service,"Content-Type":"application/json"},body:JSON.stringify({p_unit_id:unit,p_actor_id:actor,p_events:events,p_expected_refreshed_at:rows[0]?.refreshed_at??null})});
    if(!saved.ok)return reply({error:"Unable to save events. The previous snapshot is retained."},409);
    return reply({refreshed_at:await saved.json(),event_count:events.length});
  }catch{return reply({error:"BAND synchronization unavailable."},502);}
});
