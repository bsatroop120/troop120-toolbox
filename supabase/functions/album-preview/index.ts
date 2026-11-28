// Metadata lookup only; saves use the separate admin-only SQL RPC.
// No service-role key. Caller JWT is passed only to this project's API.
const cors = {
  "Access-Control-Allow-Origin": "https://bsatroop120.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {...cors, "Content-Type": "application/json", "Cache-Control": "no-store"}
});
const publicAlbum = /^https:\/\/(?:photos\.app\.goo\.gl\/[A-Za-z0-9_-]+|goo\.gl\/photos\/[A-Za-z0-9_-]+|photos\.google\.com\/share\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?)$/;
function approvedPage(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      ["photos.app.goo.gl", "goo.gl", "photos.google.com"].includes(u.hostname);
  } catch { return false; }
}
function approvedImage(value: string) {
  try {
    const u = new URL(value);
    return value.length <= 4096 && u.protocol === "https:" && !u.username && !u.password && !u.port &&
      /^lh[3-6]\.googleusercontent\.com$/.test(u.hostname);
  } catch { return false; }
}
function decode(s: string) {
  const named: Record<string,string> = {amp:"&",quot:'"',apos:"'",lt:"<",gt:">",nbsp:" "};
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole,key) => {
    if (key[0] === "#") {
      const n=key[1].toLowerCase()==="x"?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
      return Number.isFinite(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):whole;
    }
    return named[key.toLowerCase()]??whole;
  });
}
function metadata(html: string) {
  const values = new Map<string,string>();
  for (const tag of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map<string,string>();
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs.set(a[1].toLowerCase(), decode(a[2]??a[3]??a[4]??""));
    const key=(attrs.get("property")||attrs.get("name")||attrs.get("itemprop")||"").toLowerCase();
    const value=attrs.get("content");
    if(key&&value&&!values.has(key)) values.set(key,value);
  }
  return values;
}
function inferMonth(title: string) {
  const months: Record<string,string>={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  const m=title.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,.]?\s+(20\d{2})\b/i);
  return m?m[2]+"-"+months[m[1].slice(0,3).toLowerCase()]:"";
}
async function fetchPage(initial: string) {
  let url=initial;
  const signal=AbortSignal.timeout(15000);
  for(let i=0;i<6;i++){
    if(!approvedPage(url))throw Error("Unexpected redirect");
    const response=await fetch(url,{redirect:"manual",signal,headers:{Accept:"text/html","User-Agent":"Troop120Toolbox-CoverLookup/1.0"}});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get("location");await response.body?.cancel();
      if(!location)throw Error("Missing redirect");
      url=new URL(location,url).href;continue;
    }
    if(!response.ok||!response.headers.get("content-type")?.includes("text/html")||!response.body)throw Error("Album page unavailable");
    const reader=response.body.getReader(), decoder=new TextDecoder();
    let size=0,html="";
    try {
      while(true){
        const {value,done}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>5_000_000)throw Error("Album page too large");
        html+=decoder.decode(value,{stream:true});
      }
      return {html:html+decoder.decode(),url};
    }finally{await reader.cancel().catch(()=>{});}
  }
  throw Error("Too many redirects");
}
Deno.serve(async (req) => {
  if(req.method==="OPTIONS")return new Response(null,{headers:cors,status:204});
  if(req.method!=="POST")return reply({error:"Method not allowed"},405);
  const token=req.headers.get("Authorization");
  if(!token?.startsWith("Bearer "))return reply({error:"Sign-in required"},401);
  let body: {unit_id?: unknown;album_url?: unknown};
  try {
    const raw=await req.text();if(raw.length>4096)return reply({error:"Request too large"},413);
    body=JSON.parse(raw);
  }catch{return reply({error:"Invalid request"},400);}
  if(!body||typeof body.unit_id!=="string"||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.unit_id))||
      typeof body.album_url!=="string"||body.album_url.length>2048||!publicAlbum.test(body.album_url))
    return reply({error:"Use a copied Google Photos shared album link"},400);
  const api=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_ANON_KEY");
  if(!api||!key)return reply({error:"Lookup not configured"},503);
  try {
    const auth=await fetch(api+"/rest/v1/rpc/can_manage_toolbox_albums",{
      method:"POST",headers:{"Authorization":token,"apikey":key,"Content-Type":"application/json"},
      body:JSON.stringify({p_unit_id:body.unit_id}),signal:AbortSignal.timeout(8000)
    });
    if(!auth.ok||await auth.json()!==true)return reply({error:"Administrator access required"},403);
    const page=await fetchPage(body.album_url);
    const m=metadata(page.html);
    let title=(m.get("og:title")||m.get("twitter:title")||"").trim().slice(0,240);
    if(/^(google photos|shared album|photos)$/i.test(title))title="";
    let cover_url="";
    const raw=m.get("og:image:secure_url")||m.get("og:image")||m.get("twitter:image")||"";
    if(raw){const url=new URL(raw,page.url).href;if(approvedImage(url))cover_url=url;}
    return reply({title,event_month:inferMonth(title),cover_url});
  }catch{return reply({error:"Google Photos preview unavailable; enter album details manually."},502);}
});
