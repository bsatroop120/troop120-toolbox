"use strict";
const SUPABASE_URL = "https://vionsmadqxigjmygqtoe.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_JNtssN1rIQknWgW4oQhxNA_yMWPlH5Y";
const REDIRECT_URL = "https://bsatroop120.github.io/troop120-toolbox/";
const el = id => document.getElementById(id);
const label = code => ({admin:"Administrator",leader:"Adult leader",parent:"Parent or guardian",scout:"Scout"}[code] || code);
function message(id, text, error = false) {
  el(id).textContent = text;
  el(id).dataset.error = String(error);
  if (["admin-message","lifecycle-message","member-message"].includes(id) && el("manage-dialog")?.open) {
    el("manage-message").textContent = text;
    el("manage-message").dataset.error = String(error);
  }
}
function showRequests(id, rows, empty) {
  const list = el(id);
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = empty;
    list.append(li);
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = "Access request — " + row.status + (row.assigned_role ? " (role at approval: " + label(row.assigned_role) + ")" : "");
    const detail = document.createElement("span");
    detail.textContent = "Requested " + new Date(row.requested_at).toLocaleString();
    li.append(title, detail);
    list.append(li);
  }
}

async function start() {
  if (!window.supabase?.createClient) {
    message("status", "Authentication library could not load. Refresh and try again.", true);
    return;
  }
  const client = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: {flowType:"pkce",storage:window.sessionStorage,storageKey:"troop120-toolbox-auth",
      persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });
  let generation = 0;
  let currentUser = null;
  let busy = false;
  let adminUnit = null;
  let adminBusy = false;
  let adminLoaded = false;
  let familyUnit = null;
  let familyLoad = 0;
  let directoryRows = [];
  let directoryRoster = [];
  let directoryLinked = new Set();
  let directoryFamilies = [];
  let directoryMemberMap = new Map();
  let directoryConsent = new Map();
  const filterIds = ["directory-search","directory-role","directory-type","directory-status","directory-link","directory-request","directory-family"];

  function clearWorkspace() {
    currentUser = null;
    clearMyScouts(true);
    busy = false;
    adminUnit = null;
    adminBusy = false;
    adminLoaded = false;
    el("member-form").reset();
    el("member-create").disabled = false;
    el("admin-refresh").disabled = false;
    clearDirectory(true);
    for (const id of ["admin-message","member-message","lifecycle-message"]) el(id).textContent = "";
    clearNavigation();
    clearIdentity();
    for (const id of ["account-email","role-status","workspace-status","request-message","own-requests"]) el(id).textContent = "";
    for (const id of ["member-count","patrol-count","role-count"]) el(id).textContent = "—";
    for (const id of [...panelIds,"workspace"]) el(id).hidden = true;
    el("request-form").reset();
    el("request-submit").disabled = false;
  }
  function signedOut(text, error = false) {
    generation++;
    clearWorkspace();
    el("main").classList.remove("workspace");
    el("login-card").hidden = false;
    el("signed-out").hidden = false;
    el("google-sign-in").disabled = false;
    message("status", text, error);
  }
  const panelIds=["access-panel","overview-panel","my-scouts-panel","admin-panel","profile-panel","planned-panel","photos-panel"];
  const allowedPanels=new Set();
  const troopTools=[
    ["pictures","Pictures & Albums","Browse event albums in a visual gallery.","image"],
    ["menus","Menu Planning","Plan patrol meals, ingredients, shopping lists and camp cooking.","menu"],
    ["quartermaster","Quartermaster","Track troop equipment, checkout, condition and maintenance.","box"],
    ["packing","Packing Lists","Prepare personal and patrol gear lists for outings.","pack"],
    ["meetings","Meeting Planning","Build troop meeting plans, activities and assignments.","meeting"],
    ["plc","PLC Agendas","Prepare Patrol Leaders' Council agendas, decisions and action items.","list"],
    ["camping","Camping & Trips","Plan outings, itineraries, costs and logistics.","tent"],
    ["patrols","Patrols","Patrol organization, responsibilities and activities.","people"],
    ["advancement","Advancement","Troop advancement tools; Scoutbook remains the official record.","award"],
    ["resources","Resources","Useful troop forms, references and tools.","book"],
    ["communication","Communication","Troop announcements and communication resources; BAND remains the communication platform.","chat"]
  ];
  const personalTools=[
    ["calendar","Calendar & RSVP","View activities and responses when BAND integration is available.","calendar"],
    ["tasks","My Tasks","Personal and family action items and reminders.","list"],
    ["events","My Events","Activities and outings relevant to your account and family.","tent"],
    ["my-advancement","Advancement","Personal or linked Scout advancement information, subject to Scoutbook access.","award"],
    ["my-attendance","Attendance","Personal or linked Scout attendance and camping history when available.","calendar"]
  ];
  // Locally rendered vector icons; no remote icon requests or HTML injection.
  const paths={
    home:"M3 10l9-7 9 7v10h-6v-6H9v6H3z",
    people:"M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-3a4 4 0 0 0-3-4 M16 2a4 4 0 0 1 0 8",
    image:"M3 3h18v18H3z M7 8h.01 M3 17l6-6 4 4 3-3 5 5",
    menu:"M4 3v6a3 3 0 0 0 6 0V3 M7 3v18 M20 3c-4 3-5 7-5 11h5 M20 3v18",
    box:"M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10",
    pack:"M6 7h12l2 14H4z M9 7V5a3 3 0 0 1 6 0v2 M8 13h8v5H8z",
    meeting:"M3 4h18v12H9l-6 5z M7 8h10 M7 12h6",
    list:"M5 3h14v18H5z M9 7h6 M9 11h6 M9 15h6",
    tent:"M2 21L12 3l10 18z M8 21l4-8 4 8",
    award:"M12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M8 14l-2 7 6-3 6 3-2-7",
    book:"M3 4h5a4 4 0 0 1 4 4v13a5 5 0 0 0-4-2H3z M12 8a4 4 0 0 1 4-4h5v15h-5a5 5 0 0 0-4 2",
    chat:"M3 4h18v13H9l-6 4z M7 9h10 M7 13h7",
    calendar:"M3 6h18v15H3z M7 3v6 M17 3v6 M3 11h18",
    profile:"M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3",
    shield:"M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6"
  };
  function icon(name){
    const ns="http://www.w3.org/2000/svg";
    const svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 24 24");
    svg.setAttribute("aria-hidden","true");svg.classList.add("nav-icon");
    const p=document.createElementNS(ns,"path");p.setAttribute("d",paths[name]||paths.list);
    p.setAttribute("fill","none");p.setAttribute("stroke","currentColor");p.setAttribute("stroke-width","1.7");p.setAttribute("stroke-linejoin","round");p.setAttribute("stroke-linecap","round");svg.append(p);return svg;
  }
  function closeAccount(){
    el("account-menu").hidden=true;el("account-toggle").setAttribute("aria-expanded","false");
  }
  el("account-toggle").addEventListener("click",()=>{
    const open=el("account-menu").hidden;el("account-menu").hidden=!open;
    el("account-toggle").setAttribute("aria-expanded",String(open));
  });
  document.addEventListener("click",e=>{if(!el("account-control").contains(e.target))closeAccount();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!el("account-menu").hidden){closeAccount();el("account-toggle").focus();}});
  function clearNavigation(){
    resetPhotos();
    el("photos-add").hidden=true;
    allowedPanels.clear();
    for(const id of ["navigation","family-navigation","account-navigation","dashboard-tools"])el(id).replaceChildren();
    el("troop-sidebar").hidden=true;el("family-navigation").hidden=true;
    closeAccount();
  }
  function clearIdentity(){
    el("account-control").hidden=true;el("preview-tag").hidden=false;
    el("google-avatar").hidden=true;el("google-avatar").removeAttribute("src");
    el("avatar-initial").hidden=false;el("avatar-initial").textContent="?";
    el("google-name").textContent="Your account";
    for(const id of ["profile-name","profile-email","profile-roles"])el(id).textContent="";
  }
  el("google-avatar").addEventListener("error",()=>{
    el("google-avatar").hidden=true;el("avatar-initial").hidden=false;
  });
  function showIdentity(user){
    const meta=user.user_metadata||{};
    const name=(typeof meta.full_name==="string"&&meta.full_name.trim())||
      (typeof meta.name==="string"&&meta.name.trim())||user.email||"Your account";
    el("google-name").textContent=name;el("profile-name").textContent=name;
    el("profile-email").textContent=user.email||"Verified account";
    el("avatar-initial").textContent=Array.from(name)[0]?.toUpperCase()||"?";
    const picture=meta.avatar_url||meta.picture;
    if(typeof picture==="string"){
      try{
        const url=new URL(picture);
        if(url.protocol==="https:"&&!url.username&&!url.password&&["lh3.googleusercontent.com","lh4.googleusercontent.com","lh5.googleusercontent.com","lh6.googleusercontent.com"].includes(url.host)){
          el("google-avatar").src=url.href;el("google-avatar").hidden=false;el("avatar-initial").hidden=true;
        }
      }catch{}
    }
  }
  function openPanel(id,tool=null){
    if(!allowedPanels.has(id)|| (id==="admin-panel"&&!adminUnit))return;
    closeAccount();
    for(const p of panelIds)el(p).hidden=p!==id;
    if(id==="photos-panel"){renderPhotos();void loadPhotoRecords(generation); }
    if(id==="my-scouts-panel")void loadMyScouts(generation);
    else clearMyScouts(false);
    if(id==="planned-panel"&&tool){
      el("planned-title").textContent=tool[1];el("planned-description").textContent=tool[2];
      el("planned-category").textContent=personalTools.includes(tool)?"Personal & family":"Troop tools";
    }
    for(const navId of ["navigation","family-navigation","account-navigation"]){
      for(const b of el(navId).querySelectorAll("button")){
        if(b.dataset.panel===id&&(id!=="planned-panel"||b.dataset.tool===tool?.[0]))b.setAttribute("aria-current","page");
        else b.removeAttribute("aria-current");
      }
    }
  }
  function addNav(id,title,destination="navigation",iconName="list",tool=null){
    allowedPanels.add(id);
    const b=document.createElement("button");b.type="button";b.dataset.panel=id;
    if(tool)b.dataset.tool=tool[0];
    const caption=document.createElement("span");caption.textContent=title;
    b.append(icon(iconName),caption);
    b.addEventListener("click",()=>openPanel(id,tool));
    el(destination).append(b);
  }
  function addPlanned(tool,destination){
    const panel=tool[0]==="pictures"?"photos-panel":"planned-panel";
    addNav(panel,tool[1],destination,tool[3],tool);
    if(destination==="navigation"){
      const b=document.createElement("button");b.type="button";b.className="module tool-card";
      const title=document.createElement("strong");title.textContent=tool[1];
      const desc=document.createElement("span");desc.textContent=tool[2];
      const badge=document.createElement("span");badge.className="badge";badge.textContent=panel==="photos-panel"?"Available":"Planned";
      b.append(icon(tool[3]),title,desc,badge);
      b.addEventListener("click",()=>openPanel(panel,tool));el("dashboard-tools").append(b);
    }
  }
  el("profile-access").addEventListener("click",()=>openPanel("access-panel"));
  const publicAlbums=window.TROOP_PUBLIC_ALBUMS;
  let albums=publicAlbums.slice();
  let photosUnit=null, photosCanAdd=false, photosBackend=false, photosLoad=0;
  let photosLimit=24;
  let photosView="grid";
  const photoFields=["photos-search","photos-year","photos-category","photos-sort"];
  const albumCategories=[...new Set(publicAlbums.map(a=>a.category).concat(["Special Events"]))].sort();
  const approvedAlbumURL=/^https:\/\/(?:photos\.app\.goo\.gl\/[A-Za-z0-9_-]+|goo\.gl\/photos\/[A-Za-z0-9_-]+|photos\.google\.com\/share\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?)$/;
  const approvedCoverURL=/^https:\/\/lh[3-6]\.googleusercontent\.com\/[^\s]+$/;
  function refreshPhotoOptions(){
    const yr=el("photos-year"),cat=el("photos-category"),oldYear=yr.value,oldCat=cat.value;
    yr.replaceChildren(new Option("All years",""));
    for(const year of [...new Set(albums.map(a=>a.date.slice(0,4)).filter(Boolean))].sort().reverse())yr.append(new Option(year,year));
    cat.replaceChildren(new Option("All events",""));
    for(const category of albumCategories)cat.append(new Option(category,category));
    yr.value=[...yr.options].some(o=>o.value===oldYear)?oldYear:"";
    cat.value=[...cat.options].some(o=>o.value===oldCat)?oldCat:"";
  }
  refreshPhotoOptions();
  const coverForCategory=c=>({"Camping":"camp","Courts of Honor":"honor","Community Service":"service","Summer Camp":"camp","Camporees":"camporee","High Adventure":"camp","Troop Meetings":"trail","Eagle Projects":"service","Hiking & Backpacking":"trail","Water Activities":"paddle","Winter Activities":"trail","Training & Skills":"trail"}[c]||"honor");
  async function loadPhotoRecords(ticket){
    const unit=photosUnit, call=++photosLoad;
    const valid=()=>ticket===generation&&call===photosLoad&&unit===photosUnit&&!el("photos-panel").hidden;
    if(!unit||!valid())return;
    photosBackend=false;el("photos-add").disabled=true;
    try{
      const result=await client.from("toolbox_albums").select("id,album_url,title,event_month,category,cover_url,created_at",{count:"exact"}).eq("unit_id",unit).order("created_at",{ascending:false}).limit(500);
      if(!valid())return;
      if(result.error||result.count!==(result.data||[]).length)throw Error("Album records unavailable");
      const additional=(result.data||[]).map(r=>({title:r.title,url:r.album_url,date:r.event_month||"",added:r.created_at,category:r.category,cover:coverForCategory(r.category),cover_url:r.cover_url}));
      if(additional.some(a=>!approvedAlbumURL.test(a.url)||!albumCategories.includes(a.category)))throw Error("Unexpected album record");
      const seen=new Set(publicAlbums.map(a=>a.url));
      albums=publicAlbums.concat(additional.filter(a=>!seen.has(a.url)));
      photosBackend=true;
      el("photos-add").disabled=!photosCanAdd;
      message("photos-message","");
      refreshPhotoOptions();renderPhotos();
    }catch{
      if(valid()){
        photosBackend=false;albums=publicAlbums.slice();refreshPhotoOptions();renderPhotos();
        message("photos-message",photosCanAdd?"The existing archive is available. Add Album requires the album database setup and connection.":"The existing archive is available; newly added albums could not be loaded.",true);
      }
    }
  }
  function photoDate(date){if(!date)return "Date not specified";return date.length===4?date:new Date(date+"-01T12:00:00").toLocaleDateString(undefined,{year:"numeric",month:"long"});}
  function resetPhotos(){
    photosLoad++;photosUnit=null;photosCanAdd=false;photosBackend=false;albums=publicAlbums.slice();refreshPhotoOptions();message("photos-message","");
    for(const id of photoFields)el(id).value=id==="photos-sort"?"newest":"";
    photosView="grid";photosLimit=24;el("photos-more").hidden=true;
    el("photos-grid-view").setAttribute("aria-pressed","true");el("photos-list-view").setAttribute("aria-pressed","false");
    el("photos-gallery").replaceChildren();el("photos-count").textContent="";
    if(el("photos-dialog").open)el("photos-dialog").close();
    el("photos-dialog-title").textContent="";el("photos-dialog-body").replaceChildren();
  }
  // Five verified public Google Photos sharing-preview image URLs.
  // These may not exactly match the selected cover and may expire.
  const coverTrial=new Map([["https://photos.app.goo.gl/cEyRZc5f5z4Acy1a7","https://lh3.googleusercontent.com/pw/AP1GczPEVivmJVq7_CWvEIi9fPPlqlxE367r-O-Myuxbbv9q4pTfaKD31UcKvjwzbaJTQhMvSNyoA6cVDLTYYrZP0I07fhD4E0rokbldRkx7PzPwyJfEuDej=w450-h315-p-k"],["https://photos.app.goo.gl/mpA3yjmxh4XA8nXbA","https://lh3.googleusercontent.com/pw/AP1GczOYIS5AWtsgWIIywwPZdPhTc7toIQuT-ErWEjuN79QzkPRwgatIysPEzmsgAdbmL_ZMYGFC6PW9r5Bwe5FwQAl0jErNbA8ORv1w6qcFf_fTRBMuthPm=w600-h315-p-k"],["https://photos.app.goo.gl/RKAgtjwdaWAhr9o17","https://lh3.googleusercontent.com/pw/AP1GczOB-03S_pyEGHbi5mQ0Wo6gj07YIcFJTjuyzMlR6Z5yHWHfphh4u28tmFXam9-aJ0Frsej5IXc42Oxj89RlLxQmqbNBa_mFWPf6bYGLrEEJah2f8W14=w600-h315-p-k"],["https://photos.app.goo.gl/UC21dogZdXi8yU1o7","https://lh3.googleusercontent.com/pw/AP1GczOB9I8zHQlj_UvERjOHCPE36DulLMYEay9HIreSnvvgfVjaPF3mYYB7B4grxDC9A-dMR4vF1K4MILMlmXFuDILpDLWAFoWmSdKs6NSBvKuBfHHO-BDS=w600-h315-p-k"],["https://photos.app.goo.gl/vnfQbJzzJ7d5btoV8","https://lh3.googleusercontent.com/pw/AP1GczOVV9z_670rKbs1WJbtKT9Awfg6QecJhiDWP3lo6qa8LxsePdNwiSTvlUVp7q3aa6urdR1jYCA4HGCE7vfjtLGRFhvWtCIo41a2nMX5zCgGIrsl9udl=w600-h315-p-k"]]);
  function coverImage(album){
    const img=document.createElement("img");
    const fallback="./album-preview-"+album.cover+".svg";
    const candidate=album.cover_url||window.TROOP_ALBUM_COVERS?.[album.url]||coverTrial.get(album.url);
    const remote=typeof candidate==="string"&&approvedCoverURL.test(candidate)?candidate:null;
    img.alt="";img.loading="lazy";img.width=640;img.height=360;
    img.referrerPolicy="no-referrer";
    if(remote)img.addEventListener("error",()=>{img.src=fallback;},{once:true});
    img.src=remote||fallback;
    return img;
  }
  function selectAlbums(search,year,category,sort){
    const q=search.trim().toLowerCase();
    return albums.filter(a=>(!year||a.date.startsWith(year))&&(!category||a.category===category)&&
      (!q||[a.title,a.category,a.date].join(" ").toLowerCase().includes(q)))
      .sort((a,b)=>sort==="name"?a.title.localeCompare(b.title):sort==="oldest"?(a.date||"9999").localeCompare(b.date||"9999"):(b.date||b.added?.slice(0,7)||"").localeCompare(a.date||a.added?.slice(0,7)||""));
  }
  function renderPhotos(){
    if(!allowedPanels.has("photos-panel")||el("photos-panel").hidden)return;
    const rows=selectAlbums(...photoFields.map(id=>el(id).value));
    const gallery=el("photos-gallery");gallery.classList.toggle("is-list",photosView==="list");gallery.replaceChildren();
    el("photos-count").textContent="Showing "+Math.min(photosLimit,rows.length)+" of "+rows.length+" matching albums ("+albums.length+" total)";
    el("photos-more").hidden=rows.length<=photosLimit;
    for(const album of rows.slice(0,photosLimit)){
      const card=document.createElement("a");card.className="album-card";
      card.href=album.url;card.target="_blank";card.rel="noopener noreferrer";
      card.setAttribute("aria-label","Open "+album.title+" in Google Photos (new tab)");
      const cover=document.createElement("div");cover.className="album-cover";cover.append(coverImage(album));
      if(album.featured){const featured=document.createElement("span");featured.className="album-featured";featured.textContent="Featured";cover.append(featured);}
      const content=document.createElement("div");content.className="album-content";
      const cat=document.createElement("span");cat.className="album-category";cat.textContent=album.category;
      const title=document.createElement("strong");title.className="album-title";title.textContent=album.title;
      const date=document.createElement("span");date.className="album-meta";date.textContent=photoDate(album.date);
      const action=document.createElement("span");action.className="album-action";action.textContent="View in Google Photos ↗";
      content.append(cat,title,date,action);card.append(cover,content);
      gallery.append(card);
    }
    if(!rows.length){const p=document.createElement("p");p.className="album-empty";p.textContent="No albums match your filters.";gallery.append(p);}
  }
  for(const id of photoFields)el(id).addEventListener(id==="photos-search"?"input":"change",()=>{photosLimit=24;renderPhotos();});
  el("photos-more").addEventListener("click",()=>{photosLimit+=24;renderPhotos();});
  el("photos-reset").addEventListener("click",()=>{photosLimit=24;for(const id of photoFields)el(id).value=id==="photos-sort"?"newest":"";renderPhotos();});
  for(const view of ["grid","list"])el("photos-"+view+"-view").addEventListener("click",()=>{
    photosView=view;for(const v of ["grid","list"])el("photos-"+v+"-view").setAttribute("aria-pressed",String(v===view));renderPhotos();
  });
  el("photos-close").addEventListener("click",()=>el("photos-dialog").close());
  el("photos-add").addEventListener("click",()=>{
    if(!photosCanAdd||!photosBackend||!photosUnit||el("photos-panel").hidden||!allowedPanels.has("photos-panel"))return;
    const unit=photosUnit,ticket=generation;
    const valid=()=>ticket===generation&&unit===photosUnit&&photosCanAdd&&el("photos-dialog").open;
    el("photos-dialog-title").textContent="Add Album";
    const body=el("photos-dialog-body");body.replaceChildren();
    const note=document.createElement("p");note.textContent="Paste a Google Photos shared album link. Look up its title and cover, then review the details before adding it.";
    const form=document.createElement("form");
    const field=(label,type,id,required=false)=>{
      const wrap=document.createElement("div");wrap.className="field";
      const lab=document.createElement("label");lab.htmlFor=id;lab.textContent=label;
      const input=document.createElement("input");input.id=id;input.type=type;input.required=required;
      wrap.append(lab,input);return {wrap,input};
    };
    const url=field("Google Photos shared album URL","url","new-album-url",true);url.input.maxLength=2048;url.input.placeholder="https://photos.app.goo.gl/…";
    const lookup=document.createElement("button");lookup.type="button";lookup.className="secondary";lookup.textContent="Look up album";
    const title=field("Album title","text","new-album-title",true);title.input.maxLength=240;
    const month=field("Event month (optional)","month","new-album-month");
    const catWrap=document.createElement("div");catWrap.className="field";
    const catLabel=document.createElement("label");catLabel.htmlFor="new-album-category";catLabel.textContent="Event category";
    const category=document.createElement("select");category.id=catLabel.htmlFor;
    for(const c of albumCategories)category.append(new Option(c,c));category.value="Special Events";catWrap.append(catLabel,category);
    const cover=document.createElement("img");cover.className="new-album-cover";cover.alt="Google Photos preview cover";cover.referrerPolicy="no-referrer";cover.hidden=true;
    const status=document.createElement("p");status.className="status";status.setAttribute("role","status");
    const consent=document.createElement("label");consent.className="album-share-confirm";
    const check=document.createElement("input");check.type="checkbox";check.required=true;
    const caption=document.createElement("span");caption.textContent="This is a public shared album approved for troop viewing.";
    consent.append(check,caption);
    const save=document.createElement("button");save.type="submit";save.textContent="Add Album";
    let coverURL="",lookedUpURL="",busy=false;
    const setStatus=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
    const setBusy=value=>{busy=value;for(const c of [url.input,title.input,month.input,category,check,lookup,save])c.disabled=value;};
    const normalized=()=>url.input.value.trim();
    url.input.addEventListener("input",()=>{coverURL="";lookedUpURL="";cover.hidden=true;cover.removeAttribute("src");title.input.value="";month.input.value="";check.checked=false;});
    cover.addEventListener("error",()=>{cover.hidden=true;coverURL="";});
    lookup.addEventListener("click",async()=>{
      if(busy||!valid())return;
      const link=normalized();
      if(!approvedAlbumURL.test(link)){setStatus("Paste a valid public Google Photos album share link.",true);return;}
      if(albums.some(a=>a.url===link)){setStatus("This exact album link is already in the directory.",true);return;}
      setBusy(true);setStatus("Looking up album details…");
      try{
        const {data,error}=await client.functions.invoke("album-preview",{body:{unit_id:unit,album_url:link}});
        if(!valid())return;
        if(error||!data||typeof data.title!=="string")throw Error("Lookup unavailable");
        lookedUpURL=link;
        if(data.title)title.input.value=data.title.slice(0,240);
        if(typeof data.event_month==="string"&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(data.event_month))month.input.value=data.event_month;
        coverURL=typeof data.cover_url==="string"&&approvedCoverURL.test(data.cover_url)?data.cover_url:"";
        cover.hidden=!coverURL;if(coverURL)cover.src=coverURL;
        setStatus("Review the album title, date and category. "+(coverURL?"Google Photos preview found.":"No cover found; illustration will be used."));
      }catch{if(valid())setStatus("Automatic lookup is unavailable. Enter the title manually; the album can still be added.",true);}
      finally{if(valid())setBusy(false);}
    });
    form.addEventListener("submit",async e=>{
      e.preventDefault();if(busy||!valid())return;
      const link=normalized();
      if(!approvedAlbumURL.test(link)||!title.input.value.trim()||!check.checked){setStatus("A valid public album link, title and confirmation are required.",true);return;}
      if(albums.some(a=>a.url===link)){setStatus("This exact album link is already in the directory.",true);return;}
      setBusy(true);setStatus("Adding album…");
      try{
        const {error}=await client.rpc("add_toolbox_album",{p_unit_id:unit,p_album_url:link,p_title:title.input.value.trim(),p_event_month:month.input.value||null,p_category:category.value,p_cover_url:lookedUpURL===link?coverURL||null:null});
        if(!valid())return;
        if(error){setStatus(error.code==="23505"?"This exact album link already exists.":"Unable to add album. Administrator permission and valid album details are required.",true);return;}
        el("photos-dialog").close();
        for(const id of photoFields)el(id).value=id==="photos-sort"?"newest":"";
        photosLimit=24;await loadPhotoRecords(ticket);
      }catch{if(valid())setStatus("Unable to add album. Try again.",true);}
      finally{if(valid())setBusy(false);}
    });
    form.append(url.wrap,lookup,cover,title.wrap,month.wrap,catWrap,consent,status,save);
    body.append(note,form);el("photos-dialog").showModal();url.input.focus();
  });

  function clearMyScouts(resetUnit=false) {
    familyLoad++;
    if(resetUnit)familyUnit=null;
    el("my-scouts-body").replaceChildren();
    message("my-scouts-message","");
    el("my-scouts-refresh").disabled=false;
  }
  async function loadMyScouts(ticket) {
    clearMyScouts(false);
    const call=familyLoad, unit=familyUnit, user=currentUser;
    const valid=()=>ticket===generation && call===familyLoad && unit===familyUnit &&
      user===currentUser && !el("my-scouts-panel").hidden;
    if(!unit||!user||!valid())return;
    el("my-scouts-refresh").disabled=true;
    message("my-scouts-message","Checking family permissions...");
    try {
      // Recheck the current role even for adults who also have staff access.
      const [role,link]=await Promise.all([
        client.from("user_roles").select("role_code").eq("unit_id",unit).eq("profile_id",user).eq("role_code","parent").maybeSingle(),
        client.from("member_accounts").select("member_id").eq("unit_id",unit).eq("profile_id",user).maybeSingle()
      ]);
      if(!valid())return;
      if(role.error||link.error)throw Error("Permission check failed");
      if(!role.data||!link.data){
        message("my-scouts-message","Parent or guardian access is not currently assigned.",true);
        return;
      }
      const own=await client.from("members").select("id").eq("unit_id",unit).eq("id",link.data.member_id).eq("active",true).eq("member_type","adult").maybeSingle();
      if(!valid())return;
      if(own.error)throw Error("Member check failed");
      if(!own.data){message("my-scouts-message","Active adult membership could not be verified.",true);return;}
      // Explicitly filter to the signed-in adult's relationships. Staff RLS
      // may expose a larger roster, but it must never populate this view.
      const links=await client.from("family_relationships")
        .select("scout_member_id,relationship_type",{count:"exact"})
        .eq("unit_id",unit).eq("adult_member_id",own.data.id).limit(500);
      if(!valid())return;
      if(links.error||links.count!==(links.data||[]).length)throw Error("Family records incomplete");
      const relationMap=new Map((links.data||[]).map(r=>[r.scout_member_id,r.relationship_type]));
      if(!relationMap.size){message("my-scouts-message","No active linked Scouts found.");return;}
      const scouts=await client.from("members").select("id,display_name",{count:"exact"})
        .eq("unit_id",unit).eq("active",true).eq("member_type","youth")
        .in("id",[...relationMap.keys()]).order("display_name").limit(500);
      if(!valid())return;
      if(scouts.error||scouts.count!==(scouts.data||[]).length)throw Error("Scout records incomplete");
      const fragment=document.createDocumentFragment();
      for(const scout of scouts.data||[]) {
        if(!relationMap.has(scout.id))throw Error("Unexpected Scout");
        const tr=document.createElement("tr");
        for(const value of [scout.display_name,relationMap.get(scout.id)==="guardian"?"Guardian":"Parent","Active"]){
          const td=document.createElement("td");td.textContent=value;tr.append(td);
        }
        fragment.append(tr);
      }
      el("my-scouts-body").replaceChildren(fragment);
      const count=(scouts.data||[]).length;
      message("my-scouts-message",count?count+" active linked Scout"+(count===1?"":"s"):"No active linked Scouts found.");
    } catch {
      if(valid()){
        el("my-scouts-body").replaceChildren();
        message("my-scouts-message","Unable to verify family records. Refresh or contact an administrator.",true);
      }
    } finally {if(valid())el("my-scouts-refresh").disabled=false;}
  }
  el("my-scouts-refresh").addEventListener("click",()=>void loadMyScouts(generation));

  async function loadOwnRequests(userId, ticket) {
    const {data,error} = await client.from("access_requests")
      .select("assigned_role,status,requested_at").eq("profile_id",userId)
      .order("requested_at",{ascending:false}).limit(50);
    if (ticket !== generation) return;
    showRequests("own-requests", data || [], error ? "Unable to load requests." : "No requests submitted.");
  }
  function setAdminBusy(value) {
    adminBusy = value;
    el("member-create").disabled = value || !adminLoaded;
    el("admin-refresh").disabled = value;
    for (const control of el("admin-panel").querySelectorAll("button,select,input")) {
      control.disabled = value || control.dataset.unavailable === "true" || (control.id === "member-create" && !adminLoaded);
    }
  }

  function closeManage() {
    const dialog = el("manage-dialog");
    if (dialog.open) dialog.close();
    for (const id of ["manage-title","manage-email","manage-summary","manage-tabs","manage-message","manage-content"]) el(id).textContent = "";
  }
  function clearDirectory(resetFilters = false) {
    closeManage();
    directoryRows = [];
    directoryRoster = [];
    directoryLinked = new Set();
    directoryFamilies = [];
    directoryMemberMap = new Map();
    directoryConsent = new Map();
    el("directory-body").replaceChildren();
    el("directory-count").textContent = "No records loaded.";
    if (resetFilters) {
      for (const id of filterIds) el(id).value = "";
      el("directory-view").value = "family";
      el("family-view-note").hidden = false;
    }
  }
  el("manage-close").addEventListener("click",closeManage);
  el("manage-dialog").addEventListener("cancel",event=>{event.preventDefault();closeManage();});

  function requestState(row) {
    return row.requests.some(r=>r.request_status==="pending") ? "pending" : row.requests[0]?.request_status || "none";
  }
  function linkState(row) {
    return row.member ? (row.profileId ? "linked" : "unlinked") : "applicant";
  }
  function memberState(row) {
    return row.member ? (row.member.active ? "active" : "inactive") : "none";
  }
  function memberType(row) { return row.member?.member_type || "none"; }
  function displayState(code) {
    return ({active:"Active",inactive:"Inactive",linked:"Linked",unlinked:"Not linked",applicant:"Applicant only",pending:"Pending",approved:"Approved",denied:"Denied",none:"—"})[code] || code;
  }
  function familyLinks(memberId) {
    if(!memberId)return [];
    return directoryFamilies.filter(r=>r.adult_member_id===memberId||r.scout_member_id===memberId);
  }
  function familyOther(link,memberId) {
    return directoryMemberMap.get(link.adult_member_id===memberId?link.scout_member_id:link.adult_member_id);
  }
  // Display only filtered records. A Scout is placed at most once, under a
  // visible linked adult; this is a presentation choice, not a custody designation.
  function groupDirectoryRows(rows, relationships, members) {
    const visible = new Map(rows.filter(r=>r.member).map(r=>[r.member.id,r]));
    const adultLinks = new Map();
    for (const link of relationships) {
      const adult=members.get(link.adult_member_id);
      if(!adult)continue;
      if(!adultLinks.has(link.scout_member_id))adultLinks.set(link.scout_member_id,[]);
      adultLinks.get(link.scout_member_id).push({adult,link});
    }
    const children=new Map(), placed=new Set(), info=new Map();
    for(const row of rows) {
      if(row.member?.member_type!=="youth")continue;
      const candidates=(adultLinks.get(row.member.id)||[]).slice().sort((a,b)=>
        Number(b.adult.active)-Number(a.adult.active) ||
        Number(b.link.relationship_type==="parent")-Number(a.link.relationship_type==="parent") ||
        a.adult.display_name.localeCompare(b.adult.display_name) ||
        a.adult.id.localeCompare(b.adult.id));
      const selected=candidates.find(c=>visible.has(c.adult.id));
      info.set(row,{parent:selected||null,others:candidates.filter(c=>c!==selected)});
      if(!selected)continue;
      if(!children.has(selected.adult.id))children.set(selected.adult.id,[]);
      children.get(selected.adult.id).push(row);
      placed.add(row);
    }
    const ordered=[];
    for(const row of rows) {
      if(placed.has(row))continue;
      ordered.push({row,head:children.has(row.member?.id),...info.get(row)});
      for(const child of children.get(row.member?.id)||[])ordered.push({row:child,...info.get(child)});
    }
    return ordered;
  }
  function renderDirectory() {
    const query = el("directory-search").value.trim().toLowerCase();
    const role = el("directory-role").value;
    const type = el("directory-type").value;
    const state = el("directory-status").value;
    const link = el("directory-link").value;
    const request = el("directory-request").value;
    const family = el("directory-family").value;
    const rows = directoryRows.filter(row=>
      (!query || (row.name+" "+row.email+" "+row.requests.map(r=>r.applicant_name || "").join(" ")+" "+familyLinks(row.member?.id).map(r=>familyOther(r,row.member.id)?.display_name||"").join(" ")).toLowerCase().includes(query)) &&
      (!role || (role==="none" ? !row.roles.length : row.roles.includes(role))) &&
      (!type || memberType(row)===type) &&
      (!state || memberState(row)===state) &&
      (!link || linkState(row)===link) &&
      (!request || requestState(row)===request) &&
      (!family || (family==="linked" ? familyLinks(row.member?.id).length>0 : familyLinks(row.member?.id).length===0)));
    el("directory-count").textContent = "Showing "+rows.length+" of "+directoryRows.length+" records";
    const body = el("directory-body");
    body.replaceChildren();
    function cell(tr,value,stateCode) {
      const td=document.createElement("td");
      if(stateCode) {
        const span=document.createElement("span");span.className="pill";span.dataset.state=stateCode;span.textContent=value;td.append(span);
      } else td.textContent=value;
      tr.append(td);
      return td;
    }
    const grouped=el("directory-view").value==="family";
    el("family-view-note").hidden=!grouped;
    const ordered=grouped?groupDirectoryRows(rows,directoryFamilies,directoryMemberMap):rows.map(row=>({row}));
    for(const entry of ordered) {
      const {row,parent,others,head}=entry;
      const tr=document.createElement("tr");
      if(parent)tr.classList.add("family-child");
      if(head)tr.classList.add("family-head");
      const nameCell=cell(tr,row.name);
      if(parent || others?.length) {
        const caption=document.createElement("span");
        caption.className="family-caption";
        const describe=c=>c.adult.display_name+" ("+c.link.relationship_type+(c.adult.active?"":", inactive")+")";
        const parts=[];
        if(parent)parts.push(parent.link.relationship_type==="guardian"?"Guardian: "+parent.adult.display_name:"Parent: "+parent.adult.display_name);
        if(others?.length)parts.push((parent?"Also linked: ":"Linked: ")+others.map(describe).join("; "));
        caption.textContent=parts.join(" · ");
        nameCell.append(caption);
      }
      cell(tr,row.email || (row.profileId ? "Not available" : "—"));
      cell(tr,memberType(row)==="adult"?"Adult":memberType(row)==="youth"?"Scout":"—");
      cell(tr,row.roles.length?row.roles.map(label).join(", "):"None");
      cell(tr,displayState(memberState(row)),memberState(row));
      cell(tr,displayState(linkState(row)),linkState(row));
      cell(tr,displayState(requestState(row)),requestState(row));
      if(row.member?.member_type==="youth"){
        const state=directoryConsent.get(row.member.id);
        const captions={confirmed:"Confirmed (test)",withdrawn:"Withdrawn (test)",none:"Not recorded",unavailable:"Unavailable"};
        cell(tr,captions[state]||"Unavailable",state==="confirmed"?"active":state==="withdrawn"?"inactive":"none");
      } else cell(tr,"—");
      const familyCount=familyLinks(row.member?.id).length;
      cell(tr,row.member?String(familyCount):"—");
      const td=cell(tr,"");
      const manage=document.createElement("button");
      manage.type="button";manage.textContent="Manage";manage.className="secondary";
      manage.disabled=adminBusy || !adminLoaded;
      manage.setAttribute("aria-label","Manage "+row.name);
      manage.addEventListener("click",()=>openManage(row,generation));
      td.append(manage);body.append(tr);
    }
    if(!rows.length) {
      const tr=document.createElement("tr"),td=document.createElement("td");
      td.colSpan=10;td.textContent=adminLoaded?"No records match these filters.":"No records loaded.";tr.append(td);body.append(tr);
    }
  }
  for (const id of filterIds) el(id).addEventListener(id==="directory-search"?"input":"change",renderDirectory);
  el("directory-view").addEventListener("change",renderDirectory);
  el("directory-clear").addEventListener("click",()=>{for(const id of filterIds)el(id).value="";renderDirectory();});

  async function loadAdmin(ticket) {
    if (ticket !== generation || !adminUnit) return false;
    adminLoaded = false;
    clearDirectory();
    const unit = adminUnit;
    const [requests,requestKeys,members,links,roles,families] = await Promise.all([
      client.rpc("list_toolbox_access_requests",{p_unit_id:unit}),
      client.from("access_requests").select("id,profile_id",{count:"exact"}).eq("unit_id",unit).limit(500),
      client.from("members").select("id,display_name,member_type,active",{count:"exact"}).eq("unit_id",unit).order("display_name").limit(500),
      client.from("member_accounts").select("member_id,profile_id",{count:"exact"}).eq("unit_id",unit).limit(500),
      client.from("user_roles").select("profile_id,role_code",{count:"exact"}).eq("unit_id",unit).limit(500),
      client.from("family_relationships").select("adult_member_id,scout_member_id,relationship_type",{count:"exact"}).eq("unit_id",unit).limit(500)
    ]);
    if (ticket !== generation || adminUnit !== unit) return false;
    if ([requests,requestKeys,members,links,roles,families].some(r=>r.error)) {
      message("admin-message","Unable to load administrative records. Check access and refresh.",true);
      return false;
    }
    // Do not silently hide requests or account links because a server result is truncated.
    if ([requestKeys,members,links,roles,families].some(r=>r.count===null || r.count!==(r.data||[]).length)
      || (requestKeys.data||[]).length !== (requests.data||[]).length) {
      message("admin-message","Administrative record limit reached or records changed during loading. Refresh. Pagination is not implemented yet.",true);
      return false;
    }
    const roster = members.data || [];
    const linkMap = new Map((links.data||[]).map(row=>[row.member_id,row.profile_id]));
    const rolesByProfile = new Map();
    for(const r of roles.data||[]) {
      if(!rolesByProfile.has(r.profile_id)) rolesByProfile.set(r.profile_id,[]);
      rolesByProfile.get(r.profile_id).push(r.role_code);
    }
    const keyMap=new Map((requestKeys.data||[]).map(r=>[r.id,r.profile_id]));
    const byProfile=new Map();
    const rows=[];
    function newRow(profileId,member) {
      const row={profileId,member,name:member?.display_name || "Unnamed applicant",email:profileId===currentUser?el("account-email").textContent:"",roles:rolesByProfile.get(profileId)||[],requests:[]};
      rows.push(row);
      if(profileId)byProfile.set(profileId,row);
      return row;
    }
    for(const member of roster)newRow(linkMap.get(member.id)||null,member);
    for(const request of requests.data||[]) {
      const profileId=keyMap.get(request.request_id);
      if(!profileId) {
        message("admin-message","Request records changed during loading. Refresh before managing accounts.",true);
        return false;
      }
      const row=byProfile.get(profileId)||newRow(profileId,null);
      row.requests.push(request);
      if(!row.member)row.name=request.applicant_name||"Unnamed applicant";
      if(request.applicant_email)row.email=request.applicant_email;
    }
    // Include role-bearing accounts even if they have no request or member link.
    for(const profileId of rolesByProfile.keys())if(!byProfile.has(profileId))newRow(profileId,null);
    for(const row of rows)row.requests.sort((a,b)=>new Date(b.requested_at)-new Date(a.requested_at));
    rows.sort((a,b)=>a.name.localeCompare(b.name)||a.email.localeCompare(b.email));
    const memberMap=new Map(roster.map(m=>[m.id,m]));
    if((families.data||[]).some(r=>!memberMap.has(r.adult_member_id)||!memberMap.has(r.scout_member_id))) {
      message("admin-message","Family and membership records changed during loading. Refresh before managing accounts.",true);
      return false;
    }
    // Existing per-Scout history RPC: bounded parallel batches for this
    // small development roster. Do not infer consent from a failed read.
    const consent=new Map();
    const youth=roster.filter(m=>m.member_type==="youth");
    for(let i=0;i<youth.length;i+=8){
      await Promise.all(youth.slice(i,i+8).map(async m=>{
        try {
          const result=await client.rpc("list_toolbox_test_scout_consent",{p_unit_id:unit,p_scout_member_id:m.id,p_offset:0});
          const decision=result.data?.[0]?.decision;
          consent.set(m.id,result.error||!Array.isArray(result.data)?"unavailable":
            result.data.length===0?"none":["confirmed","withdrawn"].includes(decision)?decision:"unavailable");
        } catch {consent.set(m.id,"unavailable");}
      }));
      if(ticket!==generation||adminUnit!==unit)return false;
    }
    directoryConsent=consent;
    directoryRows=rows;
    directoryRoster=roster;
    directoryFamilies=families.data||[];
    directoryMemberMap=memberMap;
    directoryLinked=new Set(linkMap.keys());
    el("member-count").textContent=String(roster.length);
    adminLoaded=true;
    renderDirectory();
    return true;
  }

  function openManage(row,ticket) {
    if(!adminLoaded||adminBusy||ticket!==generation)return;
    closeManage();
    for(const id of ["admin-message","lifecycle-message","member-message"])el(id).textContent="";
    el("manage-title").textContent=row.name;
    el("manage-email").textContent=row.email || (row.profileId?"Account email unavailable in this view.":"No linked account.");
    const content=el("manage-content"), nav=el("manage-tabs"), summary=el("manage-summary");
    const chip=(name,value,state)=>{
      const item=document.createElement("span");item.className="manage-chip";
      if(state)item.dataset.state=state;
      const caption=document.createElement("span");caption.textContent=name+": ";
      const strong=document.createElement("strong");strong.textContent=value;
      item.append(caption,strong);summary.append(item);
    };
    if(row.member){
      chip("Type",row.member.member_type==="youth"?"Scout":"Adult");
      chip("Membership",displayState(memberState(row)),memberState(row));
    }
    chip("Account",displayState(linkState(row)),linkState(row));
    chip("Roles",row.roles.length?row.roles.map(label).join(", "):"None");
    if(requestState(row)!=="none")chip("Request",displayState(requestState(row)),requestState(row));

    const tabs=[];
    function activate(tab,focus=false) {
      if(!tab||adminBusy)return;
      for(const item of tabs){
        const selected=item===tab;
        item.button.setAttribute("aria-selected",String(selected));
        item.button.tabIndex=selected?0:-1;
        item.panel.hidden=!selected;
      }
      content.scrollTop=0;
      if(focus)tab.button.focus();
      tab.button.scrollIntoView({block:"nearest",inline:"nearest"});
    }
    function addTab(key,title,body){
      const button=document.createElement("button");
      button.type="button";button.id="manage-tab-"+key;button.setAttribute("role","tab");
      button.textContent=title;button.setAttribute("aria-selected","false");button.tabIndex=-1;
      const panel=document.createElement("section");
      panel.id="manage-panel-"+key;panel.className="manage-tab-panel";
      panel.setAttribute("role","tabpanel");panel.setAttribute("aria-labelledby",button.id);
      panel.tabIndex=0;panel.hidden=true;
      button.setAttribute("aria-controls",panel.id);panel.append(body);
      const entry={key,button,panel};tabs.push(entry);
      button.addEventListener("click",()=>activate(entry,true));
      button.addEventListener("keydown",event=>{
        const i=tabs.indexOf(entry),n=tabs.length;
        const target={ArrowRight:(i+1)%n,ArrowLeft:(i+n-1)%n,Home:0,End:n-1}[event.key];
        if(target!==undefined){event.preventDefault();activate(tabs[target],true);}
      });
      nav.append(button);content.append(panel);
    }
    if(row.member){
      const {settings,roles}=memberTools(row.member,row.roles,row.profileId===currentUser||row.roles.includes("admin"),ticket);
      addTab("member","Member details",settings);
      addTab("roles","Roles",roles);
      addTab("family","Family ("+familyLinks(row.member.id).length+")",familyTools(row.member,ticket));
      if(row.member.member_type==="youth")addTab("consent","Test consent",consentTools(row.member,ticket));
    }
    const requests=document.createElement("section");requests.className="manage-card";
    const heading=document.createElement("h3");heading.textContent="Access requests";requests.append(heading);
    const list=document.createElement("ul");list.className="request-list";requests.append(list);
    if(!row.requests.length){const li=document.createElement("li");li.textContent="No access requests.";list.append(li);}
    for(const request of row.requests)list.append(requestItem(request,ticket));
    const pending=row.requests.filter(r=>r.request_status==="pending").length;
    addTab("requests",pending?"Requests ("+pending+" pending)":"Requests ("+row.requests.length+")",requests);
    el("manage-dialog").showModal();
    activate(pending?tabs.find(t=>t.key==="requests"):tabs[0],true);
  }

  function consentTools(member,ticket) {
    const section=document.createElement("section");
    section.className="family-section consent-tools";
    const heading=document.createElement("h3");
    heading.textContent="Scout consent (development test only)";
    const intro=document.createElement("p");
    intro.textContent="Use fictional records only. This records an administrator's test confirmation or withdrawal; it is not legally verified consent and does not enable Scout accounts.";
    const status=document.createElement("p");status.className="status";status.setAttribute("role","status");
    const form=document.createElement("div");
    const history=document.createElement("div");
    const title=document.createElement("h3");title.textContent="Test consent history";
    const more=document.createElement("button");more.type="button";more.className="secondary";more.textContent="Load more history";more.hidden=true;
    const refresh=document.createElement("button");refresh.type="button";refresh.className="secondary";refresh.textContent="Refresh history";
    const columns=document.createElement("div");columns.className="consent-columns";
    const capture=document.createElement("div");capture.className="consent-capture";
    const captureTitle=document.createElement("h3");captureTitle.textContent="Record a decision";
    capture.append(captureTitle,form);
    const historyPanel=document.createElement("div");historyPanel.className="consent-history";
    const controls=document.createElement("div");controls.className="manage-compact-actions";controls.append(more,refresh);
    historyPanel.append(title,history,controls);columns.append(capture,historyPanel);
    section.append(heading,intro,status,columns);
    const unit=adminUnit;
    let records=[],loading=false,loaded=false,hasMore=false;
    const valid=()=>ticket===generation&&adminUnit===unit&&adminLoaded&&section.isConnected&&el("manage-dialog").open;
    const say=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
    const linked=familyLinks(member.id).map(r=>({link:r,adult:directoryMemberMap.get(r.adult_member_id)}))
      .filter(r=>r.link.scout_member_id===member.id&&r.adult?.active&&r.adult.member_type==="adult");
    function draw(){
      form.replaceChildren();history.replaceChildren();
      more.hidden=!hasMore;more.disabled=loading;
      refresh.disabled=loading;
      if(!loaded)return;
      if(member.active&&linked.length){
        const field=document.createElement("div");field.className="field";
        const select=document.createElement("select");select.id="consent-adult-"+member.id;
        const labelEl=document.createElement("label");labelEl.htmlFor=select.id;labelEl.textContent="Verified linked parent or guardian";
        select.append(new Option("Select adult",""));
        for(const {adult,link} of linked)select.append(new Option(adult.display_name+" · "+link.relationship_type+" · "+adult.id.slice(0,8),adult.id));
        field.append(labelEl,select);
        const checkLabel=document.createElement("label");checkLabel.className="family-verify";
        const check=document.createElement("input");check.type="checkbox";
        checkLabel.append(check,document.createTextNode("I independently verified this fictional guardian decision for testing."));
        const save=document.createElement("button");save.type="button";save.textContent="Record test consent";
        save.addEventListener("click",()=>{
          const adult=linked.find(r=>r.adult.id===select.value)?.adult;
          if(!adult||!check.checked){say("Select a linked adult and confirm the fictional verification.",true);return;}
          changeConsent(member,adult.id,adult.display_name,true,ticket);
        });
        form.append(field,checkLabel,save);
      } else {
        const p=document.createElement("p");p.textContent="Confirmation requires an active Scout and an active linked parent or guardian.";form.append(p);
      }
      if(!records.length){const p=document.createElement("p");p.textContent="No test consent events recorded.";history.append(p);}
      // The loaded history is a newest-first prefix. Only its first event
      // for each adult can offer withdrawal, never a superseded confirmation.
      const seen=new Set();
      for(const event of records){
        const first=!seen.has(event.adult_member_id);seen.add(event.adult_member_id);
        const row=document.createElement("div");row.className="consent-history-row";
        const h=document.createElement("strong");h.textContent=event.adult_name+" — "+(event.decision==="confirmed"?"Confirmed (test)":"Withdrawn (test)");
        const p=document.createElement("p");p.textContent=new Date(event.recorded_at).toLocaleString()+" · "+event.notice_version;
        const context=document.createElement("p");context.className="small";
        context.textContent="Current relationship: "+(event.currently_linked?"Linked":"Not linked")+" · Adult "+(event.adult_active?"active":"inactive")+" · Scout "+(event.scout_active?"active":"inactive");
        row.append(h,p,context);
        if(first&&event.decision==="confirmed"){
          const withdraw=document.createElement("button");withdraw.type="button";withdraw.className="danger";withdraw.textContent="Record test withdrawal";
          withdraw.addEventListener("click",()=>changeConsent(member,event.adult_member_id,event.adult_name,false,ticket));
          row.append(withdraw);
        }
        history.append(row);
      }
    }
    async function load(reset){
      if(!valid()||loading||adminBusy)return;
      loading=true;
      if(reset){records=[];loaded=false;hasMore=false;}
      // Hide controls during fetch, including withdrawal buttons.
      form.replaceChildren();history.replaceChildren();more.hidden=true;refresh.disabled=true;
      say("Loading test consent history...");
      try{
        const result=await client.rpc("list_toolbox_test_scout_consent",{p_unit_id:unit,p_scout_member_id:member.id,p_offset:records.length});
        if(!valid())return;
        if(result.error||!Array.isArray(result.data))throw Error("History unavailable");
        const ids=new Set(records.map(r=>r.event_id));
        if(result.data.some(r=>ids.has(r.event_id)))throw Error("History changed");
        records.push(...result.data);hasMore=result.data.length===100;loaded=true;
        say(records.length+" test event"+(records.length===1?"":"s")+" loaded"+(hasMore?"; more may be available.":"."));
      } catch{
        if(valid()){records=[];loaded=false;hasMore=false;say("Unable to verify consent history. Refresh before recording another event.",true);}
      } finally {
        if(valid()){loading=false;draw();}
      }
    }
    refresh.addEventListener("click",()=>void load(true));
    more.addEventListener("click",()=>void load(false));
    // openManage attaches the section and opens the dialog synchronously.
    queueMicrotask(()=>void load(true));
    return section;
  }
  async function changeConsent(member,adultId,adultName,confirmed,ticket){
    if(!adminUnit||!adminLoaded||adminBusy||ticket!==generation)return;
    if(!window.confirm("Record fictional test "+(confirmed?"consent confirmation":"consent withdrawal")+" from "+adultName+" for "+member.display_name+"? This does not authorize Scout accounts."))return;
    const unit=adminUnit;
    setAdminBusy(true);
    message("lifecycle-message","Recording test consent event...");
    try{
      const result=await client.rpc("record_toolbox_test_scout_consent",{p_unit_id:unit,p_scout_member_id:member.id,p_adult_member_id:adultId,p_confirmed:confirmed});
      if(ticket!==generation||unit!==adminUnit)return;
      if(result.error){message("lifecycle-message","Test consent change failed. Refresh and verify eligibility.",true);return;}
      message("lifecycle-message",confirmed?"Test consent recorded.":"Test consent withdrawal recorded.");
      const refreshed=await loadAdmin(ticket);
      if(ticket===generation&&!refreshed)message("lifecycle-message","Test event saved. Refresh before making another change.",true);
    }catch{
      if(ticket===generation){adminLoaded=false;message("lifecycle-message","Change or refresh status uncertain. Refresh before retrying.",true);}
    }finally{if(ticket===generation)setAdminBusy(false);}
  }

  function familyTools(member,ticket) {
    const section=document.createElement("section");
    section.className="family-section";
    const heading=document.createElement("h3");
    heading.textContent="Family relationships";
    const intro=document.createElement("p");
    intro.textContent="Link verified parents or guardians to Scouts. A link alone does not assign a role. Administrators may assign the Parent or guardian role to a linked adult with at least one active linked Scout.";
    section.append(heading,intro);
    const isAdult=member.member_type==="adult";
    const links=familyLinks(member.id);
    const linkType=code=>code==="guardian"?"Guardian":"Parent";
    const counterpart=link=>familyOther(link,member.id);
    const name=m=>m.display_name+" ("+m.id.slice(0,8)+")";
    function labeledSelect(id,caption,options) {
      const field=document.createElement("div");
      field.className="field";
      const lab=document.createElement("label");
      lab.htmlFor=id;lab.textContent=caption;
      const select=document.createElement("select");
      select.id=id;
      for(const [value,title] of options)select.append(new Option(title,value));
      field.append(lab,select);
      return {field,select};
    }
    function confirmText(adult,scout,type) {
      return "Verify "+adult.display_name+" is the "+linkType(type).toLowerCase()+" of "+scout.display_name+" and save this fictional relationship?";
    }
    function saveLink(adult,scout,type) {
      changeFamily("set_toolbox_family_relationship",adult.id,scout.id,type,
        confirmText(adult,scout,type),"Family relationship saved.",ticket);
    }
    if(!links.length) {
      const empty=document.createElement("p");
      empty.textContent="No family relationships recorded.";
      section.append(empty);
    }
    for(const link of links) {
      const other=counterpart(link);
      if(!other)continue;
      const adult=isAdult?member:other,scout=isAdult?other:member;
      const row=document.createElement("div");row.className="family-row";
      const person=document.createElement("strong");person.className="family-person";person.textContent=name(other);
      const state=document.createElement("span");state.className="family-state";
      state.textContent=linkType(link.relationship_type)+" · "+(other.active?"Active":"Inactive");
      row.append(person,state);
      const actions=document.createElement("div");actions.className="actions";
      if(adult.active&&scout.active) {
        const {field,select}=labeledSelect("family-type-"+other.id,"Relationship type",[
          ["parent","Parent"],["guardian","Guardian"]]);
        select.value=link.relationship_type;
        row.append(field);
        const save=document.createElement("button");save.type="button";save.className="secondary";save.textContent="Save relationship";
        save.addEventListener("click",()=>{
          if(select.value===link.relationship_type){message("lifecycle-message","No relationship change to save.");return;}
          saveLink(adult,scout,select.value);
        });
        actions.append(save);
      }
      const remove=document.createElement("button");remove.type="button";remove.className="danger";remove.textContent="Remove link";
      remove.addEventListener("click",()=>changeFamily("remove_toolbox_family_relationship",adult.id,scout.id,null,
        "Remove the family link between "+adult.display_name+" and "+scout.display_name+"? This removes access through that relationship and may revoke the Parent role if no active linked Scouts remain. Independent leader permissions are not affected.",
        "Family relationship removed.",ticket));
      actions.append(remove);row.append(actions);section.append(row);
    }
    if(!member.active) {
      const note=document.createElement("p");note.textContent="Reactivate this member before adding new relationships.";section.append(note);return section;
    }
    const already=new Set(links.map(r=>counterpart(r)?.id));
    const eligible=directoryRoster.filter(m=>m.active&&m.member_type===(isAdult?"youth":"adult")&&!already.has(m.id));
    const add=document.createElement("div");add.className="family-add";
    const addTitle=document.createElement("h3");addTitle.textContent=isAdult?"Link a Scout":"Link a parent or guardian";
    add.append(addTitle);
    const {field:otherField,select:otherSelect}=labeledSelect("family-other-"+member.id,isAdult?"Scout":"Adult",[
      ["",isAdult?"Choose an active Scout":"Choose an active adult"],...eligible.map(m=>[m.id,name(m)])]);
    const {field:typeField,select:typeSelect}=labeledSelect("family-new-type-"+member.id,"Relationship type",[
      ["","Select relationship"],["parent","Parent"],["guardian","Guardian"]]);
    add.append(otherField,typeField);
    const verifyLabel=document.createElement("label");verifyLabel.className="family-verify";
    const verify=document.createElement("input");verify.type="checkbox";
    verifyLabel.append(verify,document.createTextNode("I verified this fictional parent or guardian relationship."));
    add.append(verifyLabel);
    const submit=document.createElement("button");submit.type="button";submit.textContent="Add family link";
    submit.disabled=!eligible.length;submit.dataset.unavailable=String(!eligible.length);
    submit.addEventListener("click",()=>{
      const other=eligible.find(m=>m.id===otherSelect.value);
      if(!other||!["parent","guardian"].includes(typeSelect.value)||!verify.checked){
        message("lifecycle-message","Choose the member and relationship type, then confirm verification.",true);return;
      }
      saveLink(isAdult?member:other,isAdult?other:member,typeSelect.value);
    });
    add.append(submit);
    if(!eligible.length){const note=document.createElement("p");note.textContent="No eligible unlinked members of the required type. Add a test member if needed.";add.append(note);}
    section.append(add);
    return section;
  }
  async function changeFamily(fn,adultId,scoutId,type,confirmation,success,ticket) {
    if(!adminUnit||!adminLoaded||adminBusy||ticket!==generation)return;
    if(!window.confirm(confirmation))return;
    setAdminBusy(true);
    message("lifecycle-message","Saving family relationship...");
    try {
      const args={p_unit_id:adminUnit,p_adult_member_id:adultId,p_scout_member_id:scoutId};
      if(type!==null)args.p_relationship_type=type;
      const {error}=await client.rpc(fn,args);
      if(ticket!==generation)return;
      if(error) {
        message("lifecycle-message","Family change failed. Refresh and verify the selected members and relationship.",true);
        return;
      }
      message("lifecycle-message",success);
      const refreshed=await loadAdmin(ticket);
      if(ticket===generation&&!refreshed)message("lifecycle-message",success+" Refresh before making another change.",true);
    } catch {
      if(ticket===generation){adminLoaded=false;message("lifecycle-message","Change or refresh status uncertain. Refresh before retrying.",true);}
    } finally {
      if(ticket===generation)setAdminBusy(false);
    }
  }

  function eligibleParent(member) {
    return !!member && member.active && member.member_type==="adult" &&
      familyLinks(member.id).some(link=>link.adult_member_id===member.id &&
        directoryMemberMap.get(link.scout_member_id)?.member_type==="youth" &&
        directoryMemberMap.get(link.scout_member_id)?.active===true);
  }
  function roleSelector(id, canGrantLeader, canGrantParent=false) {
    const field=document.createElement("div");
    field.className="field";
    const title=document.createElement("label");
    title.htmlFor=id;
    title.textContent="Role to assign";
    const select=document.createElement("select");
    select.id=id;
    select.append(new Option("Select role",""));
    for (const [code,caption,enabled] of [
      ["leader","Adult leader",canGrantLeader],
      ["parent","Parent / guardian",canGrantParent],
      ["scout","Scout (consent workflow pending)",false]
    ]) {
      const option=new Option(caption,code);
      option.disabled=!enabled;
      select.append(option);
    }
    field.append(title,select);
    return {field,select};
  }

  function requestItem(row,ticket) {
    const li=document.createElement("li");
    const title=document.createElement("strong");
    // The existing admin RPC returns the historical assigned role under requested_role.
    title.textContent="Access request — "+row.request_status+(row.request_status==="approved"&&row.requested_role?" (role at approval: "+label(row.requested_role)+")":"");
    const detail=document.createElement("span");
    detail.textContent="Requested "+new Date(row.requested_at).toLocaleString()+(row.email_verified?" · Verified email":" · Email not verified");
    li.append(title,detail);
    if(row.request_status!=="pending")return li;
    const box=document.createElement("div");box.className="review-controls";
    const actions=document.createElement("div");actions.className="actions";
    if(row.email_verified) {
      const {field:roleField,select:role}=roleSelector("assign-"+row.request_id,true);
      box.append(roleField);
      const field=document.createElement("div");field.className="field";
      const select=document.createElement("select");
      select.id="review-"+row.request_id;
      const title=document.createElement("label");title.htmlFor=select.id;title.textContent="Associate with adult member";
      select.append(new Option("Choose an active adult member",""));
      for(const m of directoryRoster)if(m.active&&m.member_type==="adult"&&(row.linked_member_id?m.id===row.linked_member_id:!directoryLinked.has(m.id))) {
        select.append(new Option(m.display_name+" · "+m.id.slice(0,8),m.id));
      }
      if(row.linked_member_id)select.value=row.linked_member_id;
      const eligibility=document.createElement("p");
      eligibility.className="small";
      function updateEligibility() {
        const member=directoryMemberMap.get(select.value);
        const adult=!!member && member.active && member.member_type==="adult";
        const parent=eligibleParent(member);
        role.querySelector('option[value="leader"]').disabled=!adult;
        role.querySelector('option[value="parent"]').disabled=!parent;
        if(role.value && role.selectedOptions[0]?.disabled)role.value="";
        eligibility.textContent=!adult?"Select an active adult member first.":parent
          ?"This member has an active family link. Verify identity and eligibility before assigning a role."
          :"Parent assignment requires at least one active linked Scout.";
      }
      select.addEventListener("change",updateEligibility);
      field.append(title,select);box.append(field,eligibility);
      updateEligibility();
      const checkLabel=document.createElement("label");checkLabel.className="check";
      const check=document.createElement("input");check.type="checkbox";
      checkLabel.append(check,document.createTextNode("I verified the account, selected the correct member and confirmed the person is eligible for the assigned role."));box.append(checkLabel);
      const approve=document.createElement("button");approve.type="button";approve.textContent="Approve and assign role";
      approve.addEventListener("click",()=>{
        const member=directoryMemberMap.get(select.value);
        if(!member?.active||member.member_type!=="adult"||!["leader","parent"].includes(role.value)||!check.checked||(role.value==="parent"&&!eligibleParent(member))){message("admin-message","Select an eligible role, the correct active adult member and confirm verification.",true);return;}
        review(row,true,select.value,role.value,ticket);
      });
      actions.append(approve);
    } else {
      const note=document.createElement("p");note.className="small";note.textContent="The applicant must have a verified email before approval.";box.append(note);
    }
    const deny=document.createElement("button");deny.type="button";deny.className="danger";deny.textContent="Deny request";
    deny.addEventListener("click",()=>review(row,false,null,null,ticket));actions.append(deny);box.append(actions);li.append(box);
    return li;
  }

  function memberTools(member,assigned,protectedMember,ticket) {
    const box=document.createElement("section");
    box.className="manage-card member-tools";
    const heading=document.createElement("h3");heading.textContent="Member details";box.append(heading);
    const roleBox=document.createElement("section");
    roleBox.className="manage-card member-tools";
    const roleHeading=document.createElement("h3");roleHeading.textContent="Assigned roles";roleBox.append(roleHeading);
    const current=document.createElement("p");current.className="manage-current-roles";
    current.textContent=assigned.length?assigned.map(label).join(", "):"No roles assigned";
    roleBox.append(current);
    const field = document.createElement("div");
    field.className = "field";
    const nameLabel = document.createElement("label");
    const input = document.createElement("input");
    input.id = "edit-" + member.id;
    input.type = "text";
    input.maxLength = 100;
    input.value = member.display_name;
    nameLabel.htmlFor = input.id;
    nameLabel.textContent = "Member display name";
    field.append(nameLabel,input);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "secondary";
    save.textContent = "Save name";
    save.addEventListener("click",()=>{
      const name = input.value.trim();
      if (!name || name.length > 100) {
        message("lifecycle-message","Enter a valid member name.",true);
        return;
      }
      if (name === member.display_name) {
        message("lifecycle-message","No name change to save.");
        return;
      }
      changeMember("update_toolbox_member_name",{p_display_name:name},member,
        "Rename " + member.display_name + " to " + name + "?","Member name updated.",ticket);
    });
    const editRow=document.createElement("div");editRow.className="manage-inline-form";
    editRow.append(field,save);box.append(editRow);
    if (protectedMember) {
      const note = document.createElement("p");
      note.textContent = "Protected administrator membership. Status and role changes are unavailable.";
      box.append(note);
      const roleNote=document.createElement("p");roleNote.textContent="Administrator roles are protected and cannot be changed here.";roleBox.append(roleNote);
      return {settings:box,roles:roleBox};
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const active = document.createElement("button");
    active.type = "button";
    active.className = member.active ? "danger" : "secondary";
    active.textContent = member.active ? "Deactivate member" : "Reactivate member";
    active.addEventListener("click",()=>changeMember(
      "set_toolbox_member_active",{p_active:!member.active},member,
      member.active
        ? "Deactivate " + member.display_name + "? All assigned troop roles will be removed. The member record and account link will be retained." + (member.member_type==="youth"?" Any linked adult without another active linked Scout will also lose their Parent role.":"")
        : "Reactivate " + member.display_name + "? Roles will NOT be restored automatically.",
      member.active ? "Member deactivated; assigned troop roles removed." : "Member reactivated; an administrator must assign roles to restore access.",ticket));
    const membership=document.createElement("div");membership.className="manage-membership";
    const membershipText=document.createElement("div");
    const membershipTitle=document.createElement("h3");membershipTitle.textContent="Membership status";
    const membershipNote=document.createElement("p");membershipNote.textContent=member.active?"Active — deactivation removes assigned roles but retains the member record.":"Inactive — reactivation does not restore roles automatically.";
    membershipText.append(membershipTitle,membershipNote);
    actions.append(active);membership.append(membershipText,actions);box.append(membership);
    if (member.active && directoryLinked.has(member.id)) {
      const heading=document.createElement("h3");
      heading.textContent="Assign role";
      roleBox.append(heading);
      const canGrantLeader=member.member_type==="adult"&&!assigned.includes("leader");
      const canGrantParent=eligibleParent(member)&&!assigned.includes("parent");
      const {field,select}=roleSelector("grant-"+member.id,canGrantLeader,canGrantParent);
      const grant=document.createElement("button");
      grant.type="button";grant.textContent="Assign selected role";
      grant.dataset.unavailable=String(!canGrantLeader&&!canGrantParent);
      grant.disabled=!canGrantLeader&&!canGrantParent;
      grant.addEventListener("click",()=>{
        const code=select.value;
        if(!((code==="leader"&&canGrantLeader)||(code==="parent"&&canGrantParent))){message("lifecycle-message","Select an eligible role.",true);return;}
        changeMember("grant_toolbox_member_role",{p_role_code:code},member,
          "Assign "+label(code)+" to "+member.display_name+"? Confirm identity and eligibility for this role.",
          label(code)+" role assigned.",ticket);
      });
      const grantRow=document.createElement("div");grantRow.className="manage-inline-form";grantRow.append(field,grant);roleBox.append(grantRow);
      const note=document.createElement("p");
      note.textContent=member.member_type==="youth"?"Scout role assignment is not enabled pending consent safeguards.":eligibleParent(member)
        ?"Parent assignment requires a verified family relationship. Assigned roles cannot be added twice."
        :"Parent assignment requires at least one active linked Scout.";
      roleBox.append(note);
    } else {
      const note=document.createElement("p");note.textContent=member.active?"Link an account before assigning roles.":"Reactivate this member before assigning roles.";roleBox.append(note);
    }
    const revokeArea=document.createElement("div");revokeArea.className="manage-revoke";
    for (const code of assigned.filter(r=>["leader","parent","scout"].includes(r))) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "Revoke " + label(code) + " role";
      revoke.addEventListener("click",()=>changeMember("revoke_toolbox_member_role",{p_role_code:code},member,
        "Revoke the " + label(code) + " role from " + member.display_name + "? Other assigned roles, if any, will remain.",
        label(code) + " role revoked.",ticket));
      const row = document.createElement("div");
      row.className = "actions";
      row.append(revoke);
      revokeArea.append(row);
    }
    if(revokeArea.childElementCount){
      const h=document.createElement("h3");h.textContent="Revoke roles";roleBox.append(h,revokeArea);
    }
    return {settings:box,roles:roleBox};
  }

  async function changeMember(fn,args,member,confirmation,success,ticket) {
    if (!adminUnit || !adminLoaded || adminBusy || ticket !== generation) return;
    if (!window.confirm(confirmation)) return;
    setAdminBusy(true);
    message("lifecycle-message","Saving change...");
    try {
      const {error} = await client.rpc(fn,{p_unit_id:adminUnit,p_member_id:member.id,...args});
      if (ticket !== generation) return;
      if (error) {
        message("lifecycle-message","Change failed. Refresh the records and verify administrator access.",true);
        return;
      }
      message("lifecycle-message",success);
      const refreshed = await loadAdmin(ticket);
      if (ticket === generation && !refreshed) message("lifecycle-message",success+" Records could not be refreshed. Use Refresh before making another change.",true);
    } catch {
      if(ticket === generation) {
        adminLoaded = false;
        message("lifecycle-message","Change or refresh status uncertain. Refresh before retrying.",true);
      }
    } finally {
      if(ticket === generation) setAdminBusy(false);
    }
  }

  async function review(row,approve,memberId,assignedRole,ticket) {
    if (!adminUnit || adminBusy || !adminLoaded || ticket !== generation) return;
    if (approve && (!["leader","parent"].includes(assignedRole) || (assignedRole==="parent" && !eligibleParent(directoryMemberMap.get(memberId))))) return;
    if (!window.confirm((approve ? "Approve access and assign " + label(assignedRole) + " to " : "Deny access for ") + (row.applicant_email || "this applicant") + "?")) return;
    setAdminBusy(true);
    message("admin-message","Saving review...");
    try {
      const {error} = await client.rpc("review_toolbox_access",{
        p_request_id:row.request_id,p_approve:approve,p_member_id:memberId,p_assigned_role:assignedRole
      });
      if (ticket !== generation) return;
      if (error) {
        message("admin-message","Review failed. Refresh and verify the selected member and account.",true);
        return;
      }
      message("admin-message",approve ? "Request approved and role assigned." : "Request denied.");
      await loadAdmin(ticket);
    } catch {
      if(ticket === generation) message("admin-message","Review status uncertain. Refresh before retrying.",true);
    } finally {
      if(ticket === generation) setAdminBusy(false);
    }
  }

  el("admin-refresh").addEventListener("click",async()=>{
    if (!adminUnit || adminBusy) return;
    const ticket = generation;
    setAdminBusy(true);
    message("admin-message","Refreshing...");
    try {
      if(await loadAdmin(ticket) && ticket === generation) message("admin-message","Administrative records refreshed.");
    } catch {
      if(ticket === generation) message("admin-message","Refresh failed. Try again.",true);
    } finally {
      if(ticket === generation) setAdminBusy(false);
    }
  });

  el("member-form").addEventListener("submit",async event=>{
    event.preventDefault();
    if (!adminUnit || adminBusy || !adminLoaded) return;
    const ticket = generation;
    const name = el("member-name").value.trim();
    const type = el("member-type").value;
    if(!name || name.length > 100 || !["adult","youth"].includes(type)) {
      message("member-message","Enter a fictional name and choose a member type.",true);
      return;
    }
    if(!window.confirm("Create fictional member: " + name + "?")) return;
    setAdminBusy(true);
    message("member-message","Creating member...");
    try {
      const {error} = await client.rpc("create_toolbox_member",{
        p_unit_id:adminUnit,p_display_name:name,p_member_type:type
      });
      if(ticket !== generation) return;
      if(error) {message("member-message","Member creation failed. Verify your administrator access.",true);return;}
      el("member-form").reset();
      message("member-message","Test member created.");
      await loadAdmin(ticket);
    } catch {
      if(ticket === generation) message("member-message","Creation status uncertain. Refresh before retrying.",true);
    } finally {
      if(ticket === generation) setAdminBusy(false);
    }
  });

  async function render(session) {
    if (!session) { signedOut("Ready to sign in."); return; }
    const ticket = ++generation;
    clearWorkspace();
    el("main").classList.add("workspace");
    el("login-card").hidden = true;
    el("workspace").hidden = false;
    el("account-control").hidden=false;
    el("preview-tag").hidden=true;
    el("sign-out").disabled = false;
    el("account-email").textContent = "Verifying account...";
    message("workspace-status","Checking authentication and permissions...");
    const {data:userData,error:userError} = await client.auth.getUser();
    if (ticket !== generation) return;
    if (userError || !userData?.user) {
      message("workspace-status","Unable to verify the account. Sign out and try again.",true);
      return;
    }
    const user = userData.user;
    currentUser = user.id;
    el("account-email").textContent = user.email || "Verified account";
    showIdentity(user);
    addNav("profile-panel","My Profile","account-navigation","profile");
    addNav("access-panel","My access","account-navigation","list");

    const {data:roles,error:roleError} = await client.from("user_roles")
      .select("unit_id,role_code").eq("profile_id",user.id);
    if (ticket !== generation) return;
    if (roleError) {
      message("workspace-status","Sign-in verified, but role check failed.",true);
      return;
    }
    // The account request workflow is available even without unit access.
    openPanel("access-panel");
    const {data:unit,error:unitError} = await client.from("units")
      .select("id,name").eq("slug","troop-120").maybeSingle();
    if (ticket !== generation) return;
    if (unitError) {
      message("workspace-status","Unable to check unit access.",true);
      return;
    }
    const ownRoles = (roles || []).filter(r => unit && r.unit_id === unit.id).map(r=>r.role_code);
    el("role-status").textContent = ownRoles.length
      ? "Assigned roles: " + ownRoles.map(label).join(", ")
      : "No assigned roles. Troop access has not been granted.";
    el("profile-roles").textContent=el("role-status").textContent;
    message("workspace-status","Authentication verified. Database role check successful.");
    await loadOwnRequests(user.id,ticket);
    if (ticket !== generation || !unit || !ownRoles.length) return;

    // RLS still controls every data request. Require an active visible account link
    // before showing the dashboard (a role alone is not sufficient).
    const {data:link,error:linkError} = await client.from("member_accounts")
      .select("member_id").eq("profile_id",user.id).eq("unit_id",unit.id).maybeSingle();
    if (ticket !== generation) return;
    if (linkError || !link) {
      message("workspace-status","No active member link available. Contact an administrator.",true);
      return;
    }
    const {data:member,error:memberError} = await client.from("members")
      .select("id,member_type,active").eq("unit_id",unit.id).eq("id",link.member_id).eq("active",true).maybeSingle();
    if (ticket !== generation) return;
    if (memberError || !member) {
      message("workspace-status","Active membership could not be verified.",true);
      return;
    }

    el("unit-title").textContent = unit.name;
    el("role-count").textContent = String(ownRoles.length);
    el("troop-sidebar").hidden=false;
    el("family-navigation").hidden=false;
    addNav("overview-panel","Home","navigation","home");
    for(const tool of troopTools)addPlanned(tool,"navigation");
    photosUnit=unit.id;photosCanAdd=ownRoles.includes("admin")&&member.member_type==="adult";
    el("photos-add").hidden=!photosCanAdd;el("photos-add").disabled=true;
    if(ownRoles.includes("parent") && member.member_type==="adult") {
      familyUnit=unit.id;
      addNav("my-scouts-panel","My Scouts","family-navigation","people");
    }
    for(const tool of personalTools)addPlanned(tool,"family-navigation");
    openPanel("overview-panel");
    const [members,patrols] = await Promise.all([
      client.from("members").select("id",{count:"exact",head:true}).eq("unit_id",unit.id),
      client.from("patrols").select("id",{count:"exact",head:true}).eq("unit_id",unit.id)
    ]);
    if (ticket !== generation) return;
    el("member-count").textContent = members.error ? "—" : String(members.count ?? 0);
    el("patrol-count").textContent = patrols.error ? "—" : String(patrols.count ?? 0);
    if (members.error || patrols.error) message("workspace-status","Some dashboard counts could not be loaded.",true);

    if (ownRoles.includes("admin") && member.member_type === "adult") {
      adminUnit = unit.id;
      addNav("admin-panel","Administration","account-navigation","shield");
      setAdminBusy(true);
      try { await loadAdmin(ticket); }
      catch { if(ticket === generation) message("admin-message","Unable to load administrative records.",true); }
      finally { if(ticket === generation) setAdminBusy(false); }
    }
  }

  el("request-form").addEventListener("submit",async event => {
    event.preventDefault();
    if (!currentUser || busy) return;
    const ticket = generation;
    const name = el("display-name").value.trim();
    if (!name || name.length > 100) {
      message("request-message","Enter a test display name.",true);
      return;
    }
    busy = true;
    el("request-submit").disabled = true;
    message("request-message","Submitting...");
    try {
      const {error} = await client.rpc("request_toolbox_access",{p_display_name:name});
      if (ticket !== generation) return;
      if (error) {
        message("request-message","Request could not be submitted. Try again.",true);
        return;
      }
      el("request-form").reset();
      message("request-message","Access request recorded. An administrator will determine your role.");
      await loadOwnRequests(currentUser,ticket);
    } catch {
      if(ticket === generation) message("request-message","Request could not be submitted. Try again.",true);
    } finally {
      if(ticket === generation){busy=false;el("request-submit").disabled=false;}
    }
  });

  el("google-sign-in").addEventListener("click",async () => {
    el("google-sign-in").disabled = true;
    message("status","Opening Google sign-in...");
    try {
      const {error} = await client.auth.signInWithOAuth({provider:"google",options:{redirectTo:REDIRECT_URL}});
      if(error) throw error;
    } catch { signedOut("Google sign-in could not start. Try again.",true); }
  });
  el("sign-out").addEventListener("click",async () => {
    ++generation;
    clearMyScouts(true);
    currentUser = null;
    adminUnit = null;
    adminLoaded = false;
    clearDirectory(true);
    for (const id of ["admin-message","member-message","lifecycle-message"]) el(id).textContent = "";
    el("member-form").reset();
    for (const id of panelIds) el(id).hidden = true;
    clearNavigation();
    el("sign-out").disabled = true;
    message("workspace-status","Signing out...");
    try {
      const {error} = await client.auth.signOut({scope:"local"});
      if(error) throw error;
      signedOut("Signed out.");
    } catch {
      el("sign-out").disabled = false;
      message("workspace-status","Sign-out failed. Try again before leaving this computer.",true);
    }
  });
  client.auth.onAuthStateChange(event => {
    if(event === "SIGNED_OUT") signedOut("Signed out.");
  });
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const callbackError = query.has("error") || fragment.has("error");
  const callbackCode = query.has("code");
  const {data,error} = await client.auth.getSession();
  if(callbackError || error || (callbackCode && !data?.session)) {
    if(callbackError || callbackCode) history.replaceState(null,"",location.pathname);
    signedOut("Sign-in did not complete. Use an authorized test account and try again.",true);
    return;
  }
  await render(data?.session);
}
start().catch(() => {
  const id = el("workspace").hidden ? "status" : "workspace-status";
  message(id,"Unable to initialize the Toolbox. Refresh and try again.",true);
});
