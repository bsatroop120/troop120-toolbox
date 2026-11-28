// Server-side refresh from the configured Google Doc. No document contents or keys in GitHub.
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
async function readGoogleDocument(id:string,token:string){
  const base="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(id);
  const headers={Authorization:"Bearer "+token};
  const metadata=async()=>{
    const r=await safeFetch(base+"?fields=id,name,mimeType,modifiedTime,version,trashed",{headers});
    if(!r.ok)throw Error("Google document inaccessible");
    const d=await r.json();
    if(d.id!==id||d.mimeType!=="application/vnd.google-apps.document"||d.trashed||typeof d.name!=="string"||!d.version||!Number.isFinite(Date.parse(d.modifiedTime)))throw Error("Invalid source document");
    return d;
  };
  const before=await metadata();
  const response=await safeFetch(base+"/export?mimeType=text%2Fplain",{headers});
  if(!response.ok)throw Error("Document export failed");
  const text=(await response.text()).replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");
  if(text.trim().length<100||text.length>250000||!/\bbylaws\b/i.test(text))throw Error("Invalid document text");
  const after=await metadata();
  if(before.version!==after.version||before.modifiedTime!==after.modifiedTime)throw Error("Document changed during refresh");
  return {title:after.name,body_text:text,source_modified_at:after.modifiedTime,source_url:"https://docs.google.com/document/d/"+id+"/edit"};
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="POST")return reply({error:"Method not allowed"},405);
  const bearer=req.headers.get("Authorization");
  if(!bearer?.startsWith("Bearer "))return reply({error:"Sign-in required"},401);
  let unit:string;
  try{
    const raw=await req.text();if(raw.length>1024)return reply({error:"Request too large"},413);
    unit=JSON.parse(raw).unit_id;
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
    const allowed=await safeFetch(api+"/rest/v1/rpc/can_refresh_toolbox_bylaws",{method:"POST",headers:caller,body:JSON.stringify({p_unit_id:unit})});
    if(!allowed.ok||await allowed.json()!==true)return reply({error:"Administrator access required"},403);
    const account=Deno.env.get("BYLAWS_GOOGLE_SERVICE_ACCOUNT"),doc=Deno.env.get("BYLAWS_DOCUMENT_ID");
    if(!account||!doc||!/^[A-Za-z0-9_-]+$/.test(doc))return reply({error:"Google document connection not configured"},503);
    const source=await readGoogleDocument(doc,await googleToken(account));
    const save=await safeFetch(api+"/rest/v1/rpc/save_toolbox_bylaws_snapshot",{method:"POST",headers:{Authorization:"Bearer "+service,apikey:service,"Content-Type":"application/json"},body:JSON.stringify({p_unit_id:unit,p_actor_id:actor,p_source_url:source.source_url,p_title:source.title,p_body_text:source.body_text,p_source_modified_at:source.source_modified_at})});
    if(!save.ok)return reply({error:"Unable to save the new snapshot. The previous copy is unchanged."},409);
    return reply({refreshed_at:await save.json()});
  }catch{return reply({error:"Unable to refresh the Google document. Verify its sharing permissions and server configuration. The previous copy is retained."},502);}
});
