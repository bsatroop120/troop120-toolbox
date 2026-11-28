// Server-side refresh from the configured Google Sheets calendar. No calendar contents or keys in GitHub.
const cors={"Access-Control-Allow-Origin":"https://bsatroop120.github.io","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
const bytes=(s:string)=>new TextEncoder().encode(s);
const b64url=(a:Uint8Array)=>btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const json64=(v:unknown)=>b64url(bytes(JSON.stringify(v)));
const safeFetch=(url:string,options:RequestInit={})=>fetch(url,{...options,redirect:"error",signal:AbortSignal.timeout(15000)});
async function googleToken(raw:string){
  const account=JSON.parse(raw);
  if(account.type!=="service_account"||typeof account.client_email!=="string"||typeof account.private_key!=="string")throw Error("Google service account not configured");
  const pem=account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
  const key=await crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const iat=Math.floor(Date.now()/1000);
  const assertion=json64({alg:"RS256",typ:"JWT"})+"."+json64({iss:account.client_email,scope:"https://www.googleapis.com/auth/drive.readonly",aud:"https://oauth2.googleapis.com/token",iat,exp:iat+300});
  const signature=new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,bytes(assertion)));
  const response=await safeFetch("https://oauth2.googleapis.com/token",{method:"POST",body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:assertion+"."+b64url(signature)})});
  if(!response.ok)throw Error("Google authentication failed");
  const token=(await response.json()).access_token;
  if(typeof token!=="string"||!token)throw Error("Google token unavailable");
  return token;
}
function parseCalendar(rows: unknown[][]) {
  if(!Array.isArray(rows))throw Error("Calendar range missing");
  const cell=(r,c)=>String(rows[r-7]?.[c-2]??"").trim();
  const title=cell(7,2);
  if(!/^\d{4}-\d{4}\s+Troop 120 Calendar of Events$/i.test(title))throw Error("Calendar title changed");
  const months=[], names=["January","February","March","April","May","June","July","August","September","October","November","December"];
  for(const [dayCol,eventCol] of [[2,10],[13,21]]){
    for(let row=9;row<=54;row+=9){
      const heading=cell(row,dayCol),match=heading.match(/^([A-Za-z]+)\s+(\d{4})$/);
      const month=match?names.indexOf(match[1]):-1;
      if(month<0||!match)throw Error("Month heading changed");
      const year=Number(match[2]),monthKey=year+"-"+String(month+1).padStart(2,"0");
      if(cell(row,eventCol)!==names[month])throw Error("Month event heading changed");
      const weekdays=Array.from({length:7},(_,i)=>cell(row+1,dayCol+i));
      if(!(["Su,M,Tu,W,Th,F,Sa","M,Tu,W,Th,F,Sa,Su"].includes(weekdays.join(","))))throw Error("Weekday layout changed");
      const days=Array.from({length:42},(_,i)=>cell(row+2+Math.floor(i/7),dayCol+i%7));
      const used=days.filter(Boolean);
      const expected=Array.from({length:new Date(Date.UTC(year,month+1,0)).getUTCDate()},(_,i)=>String(i+1));
      if(used.join(",")!==expected.join(","))throw Error("Calendar day grid changed");
      const firstDay=(new Date(Date.UTC(year,month,1)).getUTCDay()+(weekdays[0]==="M"?6:0))%7;
      if(days.findIndex(Boolean)!==firstDay||days.slice(firstDay,firstDay+expected.length).join(",")!==expected.join(","))throw Error("Calendar day alignment changed");
      const meetings=cell(row+1,eventCol);
      if(cell(row+1,eventCol+1))throw Error("Meeting layout changed");
      const events=[];
      for(let offset=2;offset<=7;offset++){
        const dates=cell(row+offset,eventCol),description=cell(row+offset,eventCol+1);
        if(dates||description)events.push({dates,description});
      }
      if(row<54&&(cell(row+8,eventCol)||cell(row+8,eventCol+1)))throw Error("Extra event outside calendar block");
      months.push({heading,month_key:monthKey,weekdays,days,meetings,events});
    }
  }
  const firstYear=Number(title.slice(0,4)),lastYear=Number(title.slice(5,9));
  if(lastYear!==firstYear+1||months.some((m,i)=>m.month_key!==new Date(Date.UTC(firstYear,7+i,1)).toISOString().slice(0,7)))throw Error("Calendar month sequence changed");
  const notes=[cell(62,2),cell(63,2)].filter(Boolean);
  return {title,months,notes};
}
function parseSource(value: unknown) {
  if(typeof value!=="string"||value.length>2048)throw Error("Invalid Google Sheets URL");
  const m=value.trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})(?:\/(?:edit|view))?\/?(?:\?([^#\s]*))?(?:#([^\s]*))?$/);
  if(!m)throw Error("Use a Google Sheets share link");
  const gids=[];
  for(const part of [m[2]||"",m[3]||""]){
    for(const pair of part.split("&")){
      if(pair==="gid"||pair.startsWith("gid=")){
        const v=pair.slice(4);
        if(!/^\d{1,10}$/.test(v)||Number(v)>2147483647)throw Error("Invalid sheet tab");
        gids.push(Number(v));
      }
    }
  }
  if(new Set(gids).size>1)throw Error("Conflicting sheet tabs");
  return {id:m[1],gid:gids.length?gids[0]:null};
}
async function readCalendar(id:string,gid:number|null,token:string){
  const base="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(id),headers={Authorization:"Bearer "+token};
  const meta=async()=>{
    const r=await safeFetch(base+"?fields=id,mimeType,modifiedTime,version,trashed",{headers});
    if(!r.ok)throw Error("Google spreadsheet inaccessible");
    const d=await r.json();
    if(d.id!==id||d.mimeType!=="application/vnd.google-apps.spreadsheet"||d.trashed||!d.version||!Number.isFinite(Date.parse(d.modifiedTime)))throw Error("Invalid calendar source");
    return d;
  };
  const before=await meta(),api="https://sheets.googleapis.com/v4/spreadsheets/"+encodeURIComponent(id);
  const book=await safeFetch(api+"?fields=spreadsheetId,sheets(properties(sheetId,title,hidden))",{headers});
  if(!book.ok)throw Error("Google Sheets API unavailable");
  const info=await book.json(),tabs=info.sheets?.filter((s:any)=>!s.properties?.hidden&&(gid===null?s.properties?.title==="Troop Calendar":s.properties?.sheetId===gid));
  if(info.spreadsheetId!==id||tabs?.length!==1||typeof tabs[0].properties.title!=="string"||!Number.isInteger(tabs[0].properties.sheetId))throw Error("Calendar tab not found; include its gid in the URL");
  const tab=tabs[0].properties;
  const range=encodeURIComponent("'"+tab.title.replace(/'/g,"''")+"'!B7:V63");
  const response=await safeFetch(api+"/values/"+range+"?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS",{headers});
  if(!response.ok)throw Error("Calendar range inaccessible");
  const data=await response.json();
  if(!Array.isArray(data.values))throw Error("Calendar range unavailable");
  const calendar=parseCalendar(data.values);
  const after=await meta();
  if(before.version!==after.version||before.modifiedTime!==after.modifiedTime)throw Error("Calendar changed during refresh");
  return {title:calendar.title,calendar,source_modified_at:after.modifiedTime,source_url:"https://docs.google.com/spreadsheets/d/"+id+"/edit?gid="+tab.sheetId};
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="POST")return reply({error:"Method not allowed"},405);
  const bearer=req.headers.get("Authorization");
  if(!bearer?.startsWith("Bearer "))return reply({error:"Sign-in required"},401);
  let unit:string,mode:string,candidate:unknown;
  try{
    const raw=await req.text();if(raw.length>4096)return reply({error:"Request too large"},413);
    const input=JSON.parse(raw);unit=input.unit_id;mode=input.mode??"refresh";candidate=input.source_url;
    if(!["refresh","test","replace"].includes(mode))throw Error("Invalid operation");
    if(mode!=="refresh")parseSource(candidate);
    else if(candidate!==undefined)throw Error("Refresh uses the saved source");
    if(typeof unit!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unit))throw Error("Invalid unit");
  }catch{return reply({error:"Invalid request"},400);}
  const api=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!api||!anon||!service)return reply({error:"Refresh not configured"},503);
  const caller={Authorization:bearer,apikey:anon,"Content-Type":"application/json"};
  try{
    const user=await safeFetch(api+"/auth/v1/user",{headers:caller});
    if(!user.ok)return reply({error:"Sign-in required"},401);
    const actor=(await user.json()).id;
    if(typeof actor!=="string")return reply({error:"Sign-in required"},401);
    const allowed=await safeFetch(api+"/rest/v1/rpc/can_refresh_toolbox_troop_calendar",{method:"POST",headers:caller,body:JSON.stringify({p_unit_id:unit})});
    if(!allowed.ok||await allowed.json()!==true)return reply({error:"Administrator access required"},403);
    const account=Deno.env.get("BYLAWS_GOOGLE_SERVICE_ACCOUNT"),fallback=Deno.env.get("TROOP_CALENDAR_SPREADSHEET_ID");
    if(!account)return reply({error:"Google service account not configured"},503);
    const current=await safeFetch(api+"/rest/v1/toolbox_troop_calendar?select=source_url,refreshed_at&unit_id=eq."+encodeURIComponent(unit),{headers:caller});
    if(!current.ok)return reply({error:"Calendar storage unavailable"},503);
    const rows=await current.json();
    if(!Array.isArray(rows)||rows.length>1)throw Error("Invalid current calendar");
    const existing=rows[0];
    let target;
    if(mode==="refresh"){
      if(existing)target=parseSource(existing.source_url);
      else if(fallback&&/^[A-Za-z0-9_-]{10,200}$/.test(fallback))target={id:fallback,gid:null};
      else return reply({error:"Paste the calendar URL and save the source first"},400);
    }else target=parseSource(candidate);
    const source=await readCalendar(target.id,target.gid,await googleToken(account));
    if(mode==="test")return reply({title:source.title,source_url:source.source_url,month_count:source.calendar.months.length});
    const save=await safeFetch(api+"/rest/v1/rpc/save_toolbox_troop_calendar_snapshot",{method:"POST",headers:{Authorization:"Bearer "+service,apikey:service,"Content-Type":"application/json"},body:JSON.stringify({p_unit_id:unit,p_actor_id:actor,p_source_url:source.source_url,p_title:source.title,p_calendar:source.calendar,p_source_modified_at:source.source_modified_at,p_expected_refreshed_at:existing?.refreshed_at??null})});
    if(!save.ok)return reply({error:"Unable to save the new snapshot. The previous copy is unchanged."},409);
    return reply({refreshed_at:await save.json(),source_url:source.source_url});
  }catch{return reply({error:"Unable to refresh the Google Sheets calendar. Verify its sharing permissions and server configuration. The previous copy is retained."},502);}
});
