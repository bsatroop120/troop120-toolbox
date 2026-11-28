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
  let bandUnit=null,bandCanRefresh=false,bandBusy=false,bandLoad=0,bandDefault=2,bandRangeOverride=null,bandMonthOverride="",bandDefaultReady=false,bandDefaultSaving=false,bandHomeSnapshot=null;
  let calendarUnit=null,calendarCanRefresh=false,calendarData=null,calendarLoad=0,calendarBusy=false,calendarSavedSource="";
  let bylawsUnit=null,bylawsCanRefresh=false,bylawsData=null,bylawsLoad=0,bylawsBusy=false;
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
  const panelIds=["access-panel","overview-panel","my-scouts-panel","admin-panel","profile-panel","planned-panel","photos-panel","bylaws-panel","troop-calendar-panel","band-admin-panel"];
  const allowedPanels=new Set();
  const troopTools=[
    ["troop-calendar","Troop Calendar","View the troop-wide annual schedule of meetings, campouts and activities.","calendar"],
    ["pictures","Pictures & Albums","Browse event albums in a visual gallery.","image"],
    ["menus","Menu Planning","Plan patrol meals, ingredients, shopping lists and camp cooking.","menu"],
    ["quartermaster","Quartermaster","Track troop equipment, checkout, condition and maintenance.","box"],
    ["packing","Packing Lists","Prepare personal and patrol gear lists for outings.","pack"],
    ["meetings","Meeting Planning","Build troop meeting plans, activities and assignments.","meeting"],
    ["plc","PLC Agendas","Prepare Patrol Leaders' Council agendas, decisions and action items.","list"],
    ["advancement","Advancement","Troop advancement tools; Scoutbook remains the official record.","award"],
    ["resources","Resources","Useful troop forms, references and tools.","book"],
    ["bylaws","Troop Bylaws","Troop bylaws and governing documents.","book"],
    ["new-scouts-parents","New Scouts & Parents","Getting started with Troop 120, information and resources for new Scouts and parents.","people"]
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
  function setSidebarMode(mode){
    const admin=mode==="admin"&&!!adminUnit;
    el("sidebar-heading").textContent=admin?"Administration":"Troop tools";
    el("navigation").hidden=admin;
    el("admin-navigation").hidden=!admin;
    el("admin-back").hidden=!admin;
    syncPhotoHeaderActions();
  }
  el("admin-back").addEventListener("click",()=>openPanel("overview-panel"));
  el("brand-home").addEventListener("click",()=>openPanel("overview-panel"));
  function clearNavigation(){
    setSidebarMode("troop");
    resetPhotos();
    resetBylaws();
    resetTroopCalendar();
    resetBand();
    el("photos-add").hidden=true;
    allowedPanels.clear();
    el("brand-home").disabled=true;
    for(const id of ["navigation","admin-navigation","family-navigation","account-navigation","dashboard-tools"])el(id).replaceChildren();
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
  function openPanel(id,tool=null,mode=null){
    if(!allowedPanels.has(id)|| ((id==="admin-panel"||id==="band-admin-panel"||mode==="admin")&&!adminUnit))return;
    setSidebarMode(mode||(id==="admin-panel"?"admin":"troop"));
    closeAccount();
    for(const p of panelIds)el(p).hidden=p!==id;
    if(id==="photos-panel"){renderPhotos();void loadPhotoRecords(generation); }
    if(id==="bylaws-panel"){syncBylawsControls();void loadBylaws(generation); }
    if(id==="troop-calendar-panel"){syncCalendarControls();void loadTroopCalendar(generation); }
    if(id==="overview-panel"||id==="band-admin-panel")void loadBand(generation);
    if(id==="my-scouts-panel")void loadMyScouts(generation);
    else clearMyScouts(false);
    if(id==="planned-panel"&&tool){
      el("planned-title").textContent=tool[1];el("planned-description").textContent=tool[2];
      el("planned-category").textContent=personalTools.includes(tool)?"Personal & family":"Troop tools";
    }
    for(const navId of ["navigation","admin-navigation","family-navigation","account-navigation"]){
      for(const b of el(navId).querySelectorAll("button")){
        if(b.dataset.panel===id&&(id!=="planned-panel"||b.dataset.tool===tool?.[0]))b.setAttribute("aria-current","page");
        else b.removeAttribute("aria-current");
      }
    }
  }
  function addNav(id,title,destination="navigation",iconName="list",tool=null,mode=null){
    allowedPanels.add(id);
    const b=document.createElement("button");b.type="button";b.dataset.panel=id;
    if(tool)b.dataset.tool=tool[0];
    const caption=document.createElement("span");caption.textContent=title;
    b.append(icon(iconName),caption);
    b.addEventListener("click",()=>openPanel(id,tool,mode));
    el(destination).append(b);
  }
  function addPlanned(tool,destination){
    const panel=tool[0]==="pictures"?"photos-panel":tool[0]==="bylaws"?"bylaws-panel":tool[0]==="troop-calendar"?"troop-calendar-panel":"planned-panel";
    addNav(panel,tool[1],destination,tool[3],tool);
    if(destination==="navigation"){
      const b=document.createElement("button");b.type="button";b.className="module tool-card";
      const title=document.createElement("strong");title.textContent=tool[1];
      const desc=document.createElement("span");desc.textContent=tool[2];
      const badge=document.createElement("span");badge.className="badge";badge.textContent=panel==="planned-panel"?"Planned":"Available";
      b.append(icon(tool[3]),title,desc,badge);
      b.addEventListener("click",()=>openPanel(panel,tool));el("dashboard-tools").append(b);
    }
  }
  el("profile-access").addEventListener("click",()=>openPanel("access-panel"));
  const publicAlbums=window.TROOP_PUBLIC_ALBUMS;
  let albums=[];
  let photosUnit=null, photosCanAdd=false, photosBackend=false, photosManageReady=false, photosMultiCategories=false, photosLoad=0;
  let photosLimit=24;
  let photosView="grid";
  const photoFields=["photos-search","photos-year","photos-category","photos-sort"];
  const defaultAlbumCategories=["Camping","Courts of Honor","Community Service","Summer Camp","Camporees","High Adventure","Special Events","Troop Meetings","Eagle Projects","Fundraising","Crossovers","Hiking & Backpacking","Water Activities","Winter Activities","Training & Skills"].sort();
  let albumCategories=defaultAlbumCategories.slice(),categoryCatalog=[],categoryCatalogReady=false;
  const approvedAlbumURL=/^https:\/\/(?:photos\.app\.goo\.gl\/[A-Za-z0-9_-]+|goo\.gl\/photos\/[A-Za-z0-9_-]+|photos\.google\.com\/share\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?)$/;
  const approvedCoverURL=/^https:\/\/lh[3-6]\.googleusercontent\.com\/[^\s]+$/;
  // Google Photos sharing titles often append a localized date range after a middle dot.
  // Preserve month-level precision; use the first month of an explicit range.
  function inferAlbumMonth(value){
    const text=String(value||"").replace(/\u00a0|\u202f/g," ");
    const suffix=text.includes("·")?text.slice(text.lastIndexOf("·")+1):text;
    const names="Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
    const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const number=m=>months[m.slice(0,3).toLowerCase()];
    const format=(y,m)=>y>=2000&&y<=2099?String(y)+"-"+String(m).padStart(2,"0"):"";
    const read=s=>{
      const ranges=new RegExp("\\b("+names+")\\.?\\s+(\\d{1,2})(?!\\d)(?:\\s*,?\\s*(20\\d{2}))?(?:\\s*[-–—−]\\s*(?:("+names+")\\.?\\s+)?(\\d{1,2})(?!\\d)(?:\\s*,?\\s*(20\\d{2}))?)?","gi");
      const dates=[...s.matchAll(ranges)];
      for(let i=dates.length-1;i>=0;i--){
        const d=dates[i],start=number(d[1]),end=d[4]?number(d[4]):start;
        if(Number(d[2])<1||Number(d[2])>31||(d[5]&&(Number(d[5])<1||Number(d[5])>31)))continue;
        if(d[3])return format(Number(d[3]),start);
        if(d[6])return format(Number(d[6])-(start>end?1:0),start);
      }
      const simple=[...s.matchAll(new RegExp("\\b("+names+")[,.]?\\s+(20\\d{2})\\b","gi"))].pop();
      if(simple)return format(Number(simple[2]),number(simple[1]));
      return "";
    };
    return read(suffix)||(suffix!==text?read(text):"");
  }
  function detectedAlbumMonth(data){
    return inferAlbumMonth(data.title)||(typeof data.event_month==="string"&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(data.event_month)?data.event_month:"");
  }
  function effectiveAlbumMonth(override,detected){return override||detected||null;}
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
  function photoAdminMode(){
    return !el("admin-navigation").hidden&&!!adminUnit&&photosCanAdd;
  }
  function syncPhotoHeaderActions(){
    const visible=photoAdminMode();
    el("photos-add").hidden=!visible;
    el("photos-add").disabled=!visible||!photosBackend;
    el("photos-categories").hidden=!(visible&&categoryCatalogReady);
  }
  async function loadPhotoRecords(ticket){
    const unit=photosUnit, call=++photosLoad;
    const valid=()=>ticket===generation&&call===photosLoad&&unit===photosUnit&&!el("photos-panel").hidden;
    if(!unit||!valid())return;
    photosBackend=false;photosManageReady=false;photosMultiCategories=false;categoryCatalogReady=false;syncPhotoHeaderActions();
    try{
      // After migration, the database is authoritative, including removals.
      const columns="id,album_url,title,event_month,category,cover_url,created_at";
      let rows=[],legacy=false,multi=true,total=null;
      const page=(fields,offset)=>client.from("toolbox_albums").select(fields,{count:"exact"}).eq("unit_id",unit).order("id").range(offset,offset+249);
      for(let offset=0; ; offset+=250){
        let result=await page(columns+(legacy?"":",updated_at"+(multi?",categories":"")),offset);
        if(!valid())return;
        if(offset===0&&result.error?.code==="42703"){
          multi=false;
          result=await page(columns+",updated_at",0);
          if(!valid())return;
          if(result.error?.code==="42703"){
            legacy=true;
            result=await page(columns,0);
            if(!valid())return;
          }
        }
        if(result.error||!Array.isArray(result.data)||result.count===null)throw Error("Album records unavailable");
        if(total===null)total=result.count;
        if(result.count!==total)throw Error("Album records changed during load");
        rows.push(...result.data);
        if(rows.length>=total)break;
        if(result.data.length!==250||offset>=20000)throw Error("Album records incomplete");
      }
      if(rows.length!==total||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error("Album records incomplete");
      const catalog=await client.from("toolbox_album_categories").select("id,name",{count:"exact"}).eq("unit_id",unit).order("name").limit(100);
      if(!valid())return;
      const missingCatalog=catalog.error&&["42P01","PGRST205"].includes(catalog.error.code);
      if(catalog.error&&!missingCatalog)throw Error("Category catalog unavailable");
      if(!missingCatalog&&(!Array.isArray(catalog.data)||catalog.count!==catalog.data.length||!catalog.data.length))throw Error("Category catalog incomplete");
      categoryCatalog=missingCatalog?[]:catalog.data;
      albumCategories=missingCatalog?defaultAlbumCategories.slice():categoryCatalog.map(c=>c.name).sort((a,b)=>a.localeCompare(b));
      if(new Set(albumCategories).size!==albumCategories.length)throw Error("Duplicate categories");
      categoryCatalogReady=!missingCatalog&&multi&&!legacy;
      const additional=rows.map(r=>({id:r.id,title:r.title,url:r.album_url,date:r.event_month||inferAlbumMonth(r.title),storedDate:r.event_month||"",added:r.created_at,updated:r.updated_at,category:r.category,categories:multi?r.categories:[r.category],cover:coverForCategory(r.category),cover_url:r.cover_url}));
      if(additional.some(a=>!approvedAlbumURL.test(a.url)||!albumCategories.includes(a.category)||!Array.isArray(a.categories)||!a.categories.length||a.categories.some(c=>!albumCategories.includes(c))||new Set(a.categories).size!==a.categories.length||a.categories[0]!==a.category))throw Error("Unexpected album record");
      const seen=new Set(publicAlbums.map(a=>a.url));
      albums=legacy?publicAlbums.concat(additional.filter(a=>!seen.has(a.url))):additional;
      photosBackend=true;photosManageReady=!legacy;photosMultiCategories=multi&&!legacy;
      syncPhotoHeaderActions();
      message("photos-message",photosCanAdd?(legacy?"Apply album management migration 016E to enable editing and removal.":!multi?"Apply migration 016H to assign multiple categories to albums.":!categoryCatalogReady?"Apply migration 016K to manage the category list.":""):"");
      refreshPhotoOptions();renderPhotos();
    }catch{
      if(valid()){
        photosBackend=false;photosManageReady=false;photosMultiCategories=false;categoryCatalogReady=false;categoryCatalog=[];albumCategories=defaultAlbumCategories.slice();syncPhotoHeaderActions();albums=[];refreshPhotoOptions();renderPhotos();
        message("photos-message","Album directory could not be loaded. Open Pictures & Albums again to retry.",true);
      }
    }
  }
  function photoDate(date){if(!date)return "Date not specified";return date.length===4?date:new Date(date+"-01T12:00:00").toLocaleDateString(undefined,{year:"numeric",month:"long"});}
  function resetPhotos(){
    photosLoad++;photosUnit=null;photosCanAdd=false;photosBackend=false;photosManageReady=false;photosMultiCategories=false;categoryCatalogReady=false;categoryCatalog=[];albumCategories=defaultAlbumCategories.slice();syncPhotoHeaderActions();albums=[];refreshPhotoOptions();message("photos-message","");
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
  function categoriesForAlbum(album){return Array.isArray(album.categories)?album.categories:[album.category];}
  function selectAlbums(search,year,category,sort){
    const q=search.trim().toLowerCase();
    return albums.filter(a=>(!year||a.date.startsWith(year))&&(!category||categoriesForAlbum(a).includes(category))&&
      (!q||[a.title,...categoriesForAlbum(a),a.date].join(" ").toLowerCase().includes(q)))
      .sort((a,b)=>sort==="name"?a.title.localeCompare(b.title):sort==="oldest"?(a.date||"9999").localeCompare(b.date||"9999"):(b.date||"").localeCompare(a.date||""));
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
      const cat=document.createElement("div");cat.className="album-category-tags";
      for(const value of categoriesForAlbum(album)){const tag=document.createElement("span");tag.className="album-category";tag.textContent=value;cat.append(tag);}
      const title=document.createElement("strong");title.className="album-title";title.textContent=album.title;
      const date=document.createElement("span");date.className="album-meta";date.textContent=photoDate(album.date);
      content.append(cat,title,date);card.append(cover,content);
      if(photosCanAdd&&photosBackend&&photosManageReady&&album.id&&album.updated){
        const shell=document.createElement("div");shell.className="album-admin-shell";
        const manage=document.createElement("button");manage.type="button";manage.className="album-manage secondary";manage.title="Edit album";manage.setAttribute("aria-label","Edit album: "+album.title);
        const ns="http://www.w3.org/2000/svg",pencil=document.createElementNS(ns,"svg"),stroke=document.createElementNS(ns,"path");
        pencil.setAttribute("viewBox","0 0 24 24");pencil.setAttribute("aria-hidden","true");pencil.setAttribute("focusable","false");
        stroke.setAttribute("d","m15 5 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z");stroke.setAttribute("fill","none");stroke.setAttribute("stroke","currentColor");stroke.setAttribute("stroke-width","1.7");stroke.setAttribute("stroke-linejoin","round");stroke.setAttribute("stroke-linecap","round");pencil.append(stroke);manage.append(pencil);
        manage.addEventListener("click",()=>openAlbumEditor(album));shell.append(card,manage);gallery.append(shell);
      }else gallery.append(card);
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
  el("photos-add").addEventListener("click",()=>openAlbumEditor());
  el("photos-categories").addEventListener("click",openCategoryManager);
  function openCategoryManager(){
    if(!photoAdminMode()||!photosBackend||!categoryCatalogReady||!photosUnit||el("photos-panel").hidden)return;
    const unit=photosUnit,ticket=generation,dialog=el("photos-dialog"),body=el("photos-dialog-body");
    el("photos-dialog-title").textContent="Manage Categories";body.replaceChildren();
    const box=document.createElement("div");box.className="category-manager";body.append(box);
    const valid=()=>ticket===generation&&unit===photosUnit&&photoAdminMode()&&dialog.open&&body.contains(box);
    const status=document.createElement("p");status.className="status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
    const note=document.createElement("p");note.textContent="Renaming a category updates all assigned albums.";
    const controls=[];
    let busy=false;
    const setStatus=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
    const setBusy=value=>{busy=value;for(const c of controls)c.disabled=value;};
    const run=async(rpc,args,success)=>{
      if(busy||!valid())return;
      setBusy(true);setStatus("Saving…");
      try{
        const {error}=await client.rpc(rpc,args);
        if(error){if(valid())setStatus(error.code==="23505"?"A category with that name already exists.":error.message==="Category changed or unavailable; refresh and try again"?"Category changed. Close and reopen Manage Categories.":"Unable to save category. Check the name and administrator access.",true);return;}
        if(ticket!==generation||unit!==photosUnit)return;
        await loadPhotoRecords(ticket);
        if(!valid())return;
        if(!categoryCatalogReady){dialog.close();return;}
        openCategoryManager();
        const result=el("photos-dialog-body").querySelector("[role=status]");
        if(result)result.textContent=success;
      }catch{if(valid())setStatus("Unable to save category. Try again.",true);}
      finally{if(valid())setBusy(false);}
    };
    const create=document.createElement("form");create.className="category-create";
    const createLabel=document.createElement("label");createLabel.htmlFor="category-new-name";createLabel.textContent="New category";
    const addInput=document.createElement("input");addInput.type="text";addInput.id=createLabel.htmlFor;addInput.required=true;addInput.maxLength=60;addInput.placeholder="Category name";
    const add=document.createElement("button");add.type="submit";add.textContent="Add Category";
    const addLine=document.createElement("div");addLine.className="category-edit-line";addLine.append(addInput,add);create.append(createLabel,addLine);
    controls.push(addInput,add);
    create.addEventListener("submit",e=>{e.preventDefault();const name=addInput.value.trim();if(!name){setStatus("Enter a category name.",true);return;}void run("create_toolbox_album_category",{p_unit_id:unit,p_name:name},"Category added.");});
    const list=document.createElement("div");list.className="category-manager-list";
    const heading=document.createElement("h3");heading.textContent="Existing categories ("+categoryCatalog.length+")";
    for(const row of [...categoryCatalog].sort((a,b)=>a.name.localeCompare(b.name))){
      const form=document.createElement("form");form.className="category-edit-row";
      const label=document.createElement("label");label.htmlFor="category-name-"+row.id;
      const count=albums.filter(a=>categoriesForAlbum(a).includes(row.name)).length;
      label.textContent=count+" album"+(count===1?"":"s");
      const input=document.createElement("input");input.type="text";input.id=label.htmlFor;input.value=row.name;input.maxLength=60;input.required=true;input.setAttribute("aria-label","Rename "+row.name);
      const button=document.createElement("button");button.type="submit";button.className="secondary";button.textContent="Rename";
      const line=document.createElement("div");line.className="category-edit-line";line.append(input,label,button);form.append(line);list.append(form);controls.push(input,button);
      form.addEventListener("submit",e=>{e.preventDefault();const name=input.value.trim();if(!name){setStatus("Enter a category name.",true);return;}if(name===row.name){setStatus("No change to save.");return;}if(!window.confirm("Rename "+row.name+" to "+name+"? All "+count+" assigned album listings will be updated."))return;void run("rename_toolbox_album_category",{p_unit_id:unit,p_category_id:row.id,p_expected_name:row.name,p_name:name},"Category renamed.");});
    }
    box.append(note,create,status,heading,list);
    if(!dialog.open)dialog.showModal();
    addInput.focus();
  }
  function openAlbumEditor(existing=null){
    if(!photosCanAdd||!photosBackend||!photosUnit||el("photos-panel").hidden||!allowedPanels.has("photos-panel"))return;
    if(!existing&&!photoAdminMode())return;
    if(existing&&(!photosManageReady||!existing.id||!existing.updated))return;
    const unit=photosUnit,ticket=generation,multi=photosMultiCategories;
    const valid=()=>ticket===generation&&unit===photosUnit&&photosCanAdd&&(!!existing||photoAdminMode())&&el("photos-dialog").open&&body.contains(form);
    el("photos-dialog-title").textContent=existing?"Edit Album":"Add Album";
    const body=el("photos-dialog-body");body.replaceChildren();
    const note=document.createElement("p");note.textContent=existing?"Edit the album details or refresh its Google Photos information. Removing an album only removes its Toolbox listing.":"Paste a Google Photos shared album link. Look up its title, date and cover, then review the details before adding it.";
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
    const detectedDate=document.createElement("p");detectedDate.className="album-meta";detectedDate.textContent="Google Photos date: not looked up yet";
    const month=field("Override event month (optional)","month","new-album-month");
    const dateHelp=document.createElement("p");dateHelp.className="album-meta";dateHelp.textContent="Leave blank to use the detected album month. Enter a month only to override it.";month.wrap.append(dateHelp);
    const catWrap=document.createElement("fieldset");catWrap.className="album-category-field";
    const catLabel=document.createElement("legend");catLabel.textContent=multi?"Event categories":"Event category";
    const options=document.createElement("div");options.className="album-category-options";
    const selected=existing?categoriesForAlbum(existing):multi?[]:["Special Events"];
    const categoryInputs=albumCategories.map(c=>{
      const label=document.createElement("label");label.className="album-category-option";
      const input=document.createElement("input");input.type=multi?"checkbox":"radio";input.name="new-album-category";input.value=c;input.checked=selected.includes(c);
      const caption=document.createElement("span");caption.textContent=c;label.append(input,caption);options.append(label);return input;
    });
    const chosenCategories=()=>{
      const checked=categoryInputs.filter(input=>input.checked).map(input=>input.value);
      return [...selected.filter(c=>checked.includes(c)),...checked.filter(c=>!selected.includes(c))];
    };
    const categoryHelp=document.createElement("p");categoryHelp.className="album-meta";categoryHelp.textContent=multi?"Select all categories that apply (up to 15).":"Select one category until the multiple-category database update is installed.";
    catWrap.append(catLabel,categoryHelp,options);
    const cover=document.createElement("img");cover.className="new-album-cover";cover.alt="Google Photos preview cover";cover.referrerPolicy="no-referrer";cover.hidden=true;
    const status=document.createElement("p");status.className="status";status.setAttribute("role","status");
    const consent=document.createElement("label");consent.className="album-share-confirm";
    const check=document.createElement("input");check.type="checkbox";check.required=true;
    const caption=document.createElement("span");caption.textContent="This is a public shared album approved for troop viewing.";
    consent.append(check,caption);
    const save=document.createElement("button");save.type="submit";save.textContent=existing?"Save Changes":"Add Album";
    let coverURL="",lookedUpURL="",albumMonth="",busy=false;
    const remove=document.createElement("button");remove.type="button";remove.className="album-remove secondary";remove.textContent="Remove Album";
    const duplicate=link=>albums.some(a=>a.url===link&&(!existing||a.id!==existing.id));
    if(existing){
      url.input.value=existing.url;title.input.value=existing.title;
      coverURL=existing.cover_url||"";lookedUpURL=existing.url;albumMonth=inferAlbumMonth(existing.title)||existing.date||"";
      if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(existing.storedDate))month.input.value=existing.storedDate;
      detectedDate.textContent=albumMonth?"Detected or existing date: "+photoDate(albumMonth):"Google Photos date: not available.";
      cover.hidden=!coverURL;if(coverURL&&approvedCoverURL.test(coverURL))cover.src=coverURL;check.checked=true;
    }
    const setStatus=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
    const setBusy=value=>{busy=value;for(const c of [url.input,title.input,month.input,...categoryInputs,check,lookup,save,remove])c.disabled=value;};
    const normalized=()=>url.input.value.trim();
    url.input.addEventListener("input",()=>{coverURL="";lookedUpURL="";albumMonth="";detectedDate.textContent="Google Photos date: not looked up yet";cover.hidden=true;cover.removeAttribute("src");title.input.value="";month.input.value="";check.checked=false;});
    cover.addEventListener("error",()=>{cover.hidden=true;coverURL="";});
    lookup.addEventListener("click",async()=>{
      if(busy||!valid())return;
      const link=normalized();
      if(!approvedAlbumURL.test(link)){setStatus("Paste a valid public Google Photos album share link.",true);return;}
      if(duplicate(link)){setStatus("This exact album link is already in the directory.",true);return;}
      setBusy(true);setStatus("Looking up album details…");
      try{
        const {data,error}=await client.functions.invoke("album-preview",{body:{unit_id:unit,album_url:link}});
        if(!valid())return;
        if(error||!data||typeof data.title!=="string")throw Error("Lookup unavailable");
        lookedUpURL=link;
        if(data.title)title.input.value=data.title.slice(0,240);
        albumMonth=detectedAlbumMonth(data);
        detectedDate.textContent=albumMonth?"Google Photos date: "+photoDate(albumMonth):"Google Photos date: not available. Enter an override month if known.";
        coverURL=typeof data.cover_url==="string"&&approvedCoverURL.test(data.cover_url)?data.cover_url:"";
        cover.hidden=!coverURL;if(coverURL)cover.src=coverURL;
        setStatus("Review the album title, date and categories. "+(coverURL?"Google Photos preview found.":"No cover found; illustration will be used."));
      }catch{if(valid())setStatus("Automatic lookup is unavailable. Enter the title manually; the album can still be added.",true);}
      finally{if(valid())setBusy(false);}
    });
    form.addEventListener("submit",async e=>{
      e.preventDefault();if(busy||!valid())return;
      const link=normalized();
      if(!approvedAlbumURL.test(link)||!title.input.value.trim()||!check.checked){setStatus("A valid public album link, title and confirmation are required.",true);return;}
      if(duplicate(link)){setStatus("This exact album link is already in the directory.",true);return;}
      const categories=chosenCategories();
      if(!categories.length||categories.length>15||(!multi&&categories.length!==1)){setStatus(multi?"Select between one and 15 event categories.":"Select one event category.",true);categoryInputs[0]?.focus();return;}
      setBusy(true);setStatus(existing?"Saving album…":"Adding album…");
      try{
        const fields={p_unit_id:unit,p_album_url:link,p_title:title.input.value.trim(),p_event_month:effectiveAlbumMonth(month.input.value,lookedUpURL===link?albumMonth:""),...(multi?{p_categories:categories}:{p_category:categories[0]}),p_cover_url:lookedUpURL===link?coverURL||null:null};
        const {error}=existing?await client.rpc(multi?"update_toolbox_album_categories":"update_toolbox_album",{...fields,p_album_id:existing.id,p_expected_updated_at:existing.updated}):await client.rpc(multi?"add_toolbox_album_categories":"add_toolbox_album",fields);
        if(!valid())return;
        if(error){setStatus(error.code==="23505"?"This exact album link already exists.":"Unable to save album. Check the details, administrator access, or refresh if the album has changed.",true);return;}
        el("photos-dialog").close();
        for(const id of photoFields)el(id).value=id==="photos-sort"?"newest":"";
        photosLimit=24;await loadPhotoRecords(ticket);
      }catch{if(valid())setStatus("Unable to save album. Try again.",true);}
      finally{if(valid())setBusy(false);}
    });
    remove.addEventListener("click",async()=>{
      if(!existing||busy||!valid())return;
      if(!window.confirm("Remove \""+existing.title+"\" from the Toolbox? The original Google Photos album and photos will not be deleted."))return;
      setBusy(true);setStatus("Removing album…");
      try{
        const {error}=await client.rpc("remove_toolbox_album",{p_unit_id:unit,p_album_id:existing.id,p_expected_updated_at:existing.updated});
        if(!valid())return;
        if(error){setStatus("Unable to remove album. Refresh the gallery and check administrator access.",true);return;}
        el("photos-dialog").close();await loadPhotoRecords(ticket);
      }catch{if(valid())setStatus("Unable to remove album. Try again.",true);}
      finally{if(valid())setBusy(false);}
    });
    const actions=document.createElement("div");actions.className="album-edit-actions";actions.append(save);if(existing)actions.append(remove);
    form.append(url.wrap,lookup,cover,title.wrap,detectedDate,month.wrap,catWrap,consent,status,actions);
    body.append(note,form);el("photos-dialog").showModal();(existing?title.input:url.input).focus();
  }

  function resetBand(){
    bandLoad++;bandUnit=null;bandCanRefresh=false;bandBusy=false;
    bandDefault=2;bandRangeOverride=null;bandMonthOverride="";bandDefaultReady=false;bandDefaultSaving=false;bandHomeSnapshot=null;
    el("band-home-range").value="2";el("band-default-range").value="2";
    syncBandMonthChoices([]);
    el("band-default-range").disabled=true;el("band-default-save").disabled=true;message("band-default-status","");
    for(const scope of ["home","admin"]){
      el("band-"+scope+"-events").replaceChildren();
      el("band-"+scope+"-synced").textContent="";
      message("band-"+scope+"-status","");
    }
    el("band-refresh").disabled=true;
  }
  const bandDate=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",month:"short",day:"numeric"});
  const bandDay=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short"});
  const bandTime=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit"});
  const bandKey=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
  // Calendar-month windows are measured by local dates in the troop's time zone.
  function bandLocalDateKey(value){
    const p=Object.fromEntries(bandKey.formatToParts(new Date(value)).filter(x=>["year","month","day"].includes(x.type)).map(x=>[x.type,x.value]));
    return p.year+"-"+p.month+"-"+p.day;
  }
  function bandCutoffDate(dateKey,months){
    const [year,month,day]=dateKey.split("-").map(Number);
    const target=new Date(Date.UTC(year,month-1+months,1));
    const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
    target.setUTCDate(Math.min(day,lastDay));
    return target.toISOString().slice(0,10);
  }
  function bandDisplayEvents(events,months,now=Date.now()){
    if(months===0)return events;
    const cutoff=bandCutoffDate(bandLocalDateKey(now),months);
    return events.filter(e=>bandLocalDateKey(e.starts_at)<=cutoff);
  }
  function upcomingBandEvents(events,now=Date.now()){
    if(!Array.isArray(events))throw Error("Invalid BAND snapshot");
    return events.filter(e=>e&&typeof e.title==="string"&&Number.isFinite(Date.parse(e.starts_at))&&Number.isFinite(Date.parse(e.ends_at)))
      .filter(e=>Date.parse(e.ends_at)>Date.parse(e.starts_at)?Date.parse(e.ends_at)>now:Date.parse(e.starts_at)>=now)
      .sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.title.localeCompare(b.title));
  }
  const bandFullDate=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"long",month:"long",day:"numeric",year:"numeric"});
  function bandEventWhen(e,full=false){
    const start=new Date(e.starts_at),end=new Date(e.ends_at);
    const last=e.all_day&&end>start?new Date(end.getTime()-1):end;
    const multi=bandKey.format(start)!==bandKey.format(last);
    const dateFormat=full?bandFullDate:bandDate;
    if(e.all_day)return (full||multi?dateFormat.format(start)+(multi?" – "+dateFormat.format(last):"")+" • ":"")+"All day";
    if(multi)return dateFormat.format(start)+" "+bandTime.format(start)+" – "+dateFormat.format(end)+" "+bandTime.format(end)+" ET";
    return (full?dateFormat.format(start)+" • ":"")+bandTime.format(start)+(end>start?" – "+bandTime.format(end):"")+" ET";
  }
  function verifiedBandEventLink(value){
    if(typeof value!=="string")return null;
    return /^https:\/\/band\.us\/band\/89924015\/schedule\/4%2F89924015%2F[0-9]{1,20}%2F[0-9]{8}$/.test(value)?value:null;
  }
  // Use Eastern calendar dates, including every month a multi-day event overlaps.
  function bandEventMonthBounds(e){
    const start=Date.parse(e.starts_at),end=Date.parse(e.ends_at);
    return [bandLocalDateKey(start).slice(0,7),bandLocalDateKey(end>start?end-1:start).slice(0,7)];
  }
  function bandMonthChoices(events,now=Date.now()){
    const current=bandLocalDateKey(now).slice(0,7),months=new Set();
    for(const event of events){
      const [first,last]=bandEventMonthBounds(event);
      const [year,month]=first.split("-").map(Number);
      const date=new Date(Date.UTC(year,month-1,1));
      for(let i=0;i<24;i++){
        const key=date.toISOString().slice(0,7);
        if(key>last)break;
        if(key>=current)months.add(key);
        date.setUTCMonth(date.getUTCMonth()+1);
      }
    }
    return [...months].sort();
  }
  const bandMonthLabel=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"long",year:"numeric"});
  function syncBandMonthChoices(events){
    const select=el("band-home-month"),months=bandMonthChoices(events);
    if(bandMonthOverride&&!months.includes(bandMonthOverride))bandMonthOverride="";
    const placeholder=document.createElement("option");
    placeholder.value="";placeholder.textContent=bandMonthOverride?"Current date range":"Jump to Month";
    select.replaceChildren(placeholder);
    for(const month of months){
      const option=document.createElement("option");
      option.value=month;option.textContent=bandMonthLabel.format(new Date(month+"-01T00:00:00Z"));select.append(option);
    }
    select.value=bandMonthOverride;select.disabled=months.length===0;
  }
  function bandEventsInMonth(events,month){
    return events.filter(event=>{
      const [first,last]=bandEventMonthBounds(event);
      return first<=month&&last>=month;
    });
  }
  function renderBandEvents(scope,events,refreshed){
    const box=el("band-"+scope+"-events");box.replaceChildren();
    if(scope==="home"){bandHomeSnapshot={events,refreshed};syncBandMonthChoices(events);}
    const displayed=scope==="home"?(bandMonthOverride?bandEventsInMonth(events,bandMonthOverride):bandDisplayEvents(events,bandRangeOverride??bandDefault)):events;
    for(const e of displayed){
      const start=new Date(e.starts_at);
      const card=document.createElement("article");card.className="band-event";
      const badge=document.createElement("div");badge.className="band-event-date";
      badge.dataset.monthTone=Number(bandLocalDateKey(start).slice(5,7))%2===0?"even":"odd";
      const day=document.createElement("span");day.textContent=bandDay.format(start);
      const date=document.createElement("strong");date.textContent=bandDate.format(start);
      badge.append(day,date);
      const title=document.createElement("strong");title.className="band-event-title";title.textContent=e.title;title.title=e.title;
      const when=document.createElement("span");when.className="band-event-time";when.textContent=bandEventWhen(e);when.title=when.textContent;
      const location=document.createElement("span");location.className="band-location";location.textContent=e.location||"";location.title=e.location||"";
      const url=verifiedBandEventLink(e.event_url);
      const open=document.createElement("a");open.className="band-event-open";
      open.href=url||"https://band.us/band/89924015";
      open.target="_blank";open.rel="noopener noreferrer";
      open.textContent=url?"Open Event":"Open BAND";
      open.setAttribute("aria-label",url?"Open Event in BAND: "+e.title+" (new tab)":"Open troop BAND to find "+e.title+" (new tab; direct event link unavailable)");
      if(!url){open.title="Direct event link unavailable. Opens the troop BAND.";open.dataset.fallback="true";}
      card.append(badge,title,when,location,open);box.append(card);
    }
    if(!events.length)message("band-"+scope+"-status","No upcoming events in the last synced BAND calendar.");
    else if(!displayed.length)message("band-"+scope+"-status","No events within the selected date range.");
    else message("band-"+scope+"-status","");
    el("band-"+scope+"-synced").textContent="Last synced: "+new Date(refreshed).toLocaleString("en-US",{timeZone:"America/New_York"})+" ET • "+(scope==="home"?"Showing "+displayed.length+" of "+events.length+" upcoming events":events.length+" upcoming event"+(events.length===1?"":"s"));
  }
  function syncBandDefaultControls(){
    const enabled=bandCanRefresh&&bandDefaultReady&&!bandDefaultSaving;
    el("band-default-range").disabled=!enabled;
    el("band-default-save").disabled=!enabled||Number(el("band-default-range").value)===bandDefault;
  }
  el("band-default-range").addEventListener("change",syncBandDefaultControls);
  function redrawBandHome(){
    if(bandHomeSnapshot){
      const status=el("band-home-status").textContent,isError=el("band-home-status").dataset.error==="true";
      renderBandEvents("home",upcomingBandEvents(bandHomeSnapshot.events),bandHomeSnapshot.refreshed);
      if(status&&/sync in progress|Unable to sync|refresh will retry/.test(status))message("band-home-status",status,isError);
    }
  }
  el("band-home-range").addEventListener("change",()=>{
    const value=Number(el("band-home-range").value);
    if(![0,2,3,8,12].includes(value)||!bandUnit)return;
    bandRangeOverride=value;bandMonthOverride="";redrawBandHome();
  });
  el("band-home-month").addEventListener("change",()=>{
    if(!bandUnit||!bandHomeSnapshot)return;
    const value=el("band-home-month").value;
    if(value&&!bandMonthChoices(upcomingBandEvents(bandHomeSnapshot.events)).includes(value))return;
    bandMonthOverride=value;redrawBandHome();
  });
  el("band-default-save").addEventListener("click",async()=>{
    if(!bandCanRefresh||!bandDefaultReady||bandDefaultSaving||adminUnit!==bandUnit||el("band-admin-panel").hidden)return;
    const months=Number(el("band-default-range").value),unit=bandUnit,ticket=generation;
    if(![0,2,3,8,12].includes(months))return;
    const valid=()=>ticket===generation&&unit===bandUnit;
    bandDefaultSaving=true;syncBandDefaultControls();
    message("band-default-status","Saving default…");
    try{
      const {data,error}=await client.rpc("set_toolbox_band_default_months",{p_unit_id:unit,p_months:months});
      if(!valid())return;
      if(error||data!==months)throw Error("Default not saved");
      bandDefault=months;bandRangeOverride=null;bandMonthOverride="";
      el("band-home-range").value=String(months);
      el("band-default-range").value=String(months);
      if(bandHomeSnapshot&&!el("overview-panel").hidden)renderBandEvents("home",upcomingBandEvents(bandHomeSnapshot.events),bandHomeSnapshot.refreshed);
      message("band-default-status","Default saved for all troop members.");
    }catch{if(valid())message("band-default-status","Unable to save the default. Please retry.",true);}
    finally{if(valid()){bandDefaultSaving=false;syncBandDefaultControls();}}
  });
  async function loadBand(ticket,allowAuto=true){
    const unit=bandUnit,call=++bandLoad,scope=el("band-admin-panel").hidden?"home":"admin";
    const valid=()=>ticket===generation&&call===bandLoad&&unit===bandUnit&&!el(scope==="home"?"overview-panel":"band-admin-panel").hidden;
    if(!unit||!valid())return;
    el("band-refresh").disabled=!bandCanRefresh||bandBusy;
    message("band-"+scope+"-status","Loading upcoming events…");
    try{
      const [snapshot,preference]=await Promise.all([
        client.from("toolbox_band_events").select("events,refreshed_at").eq("unit_id",unit).maybeSingle(),
        client.from("settings").select("band_default_months").eq("unit_id",unit).maybeSingle()
      ]);
      if(!valid())return;
      if(!bandDefaultSaving){
        const months=preference.data?.band_default_months;
        bandDefaultReady=!preference.error&&[0,2,3,8,12].includes(months);
        if(bandDefaultReady)bandDefault=months;
        el("band-home-range").value=String(bandRangeOverride??bandDefault);
        el("band-default-range").value=String(bandDefault);
        syncBandDefaultControls();
        if(scope==="admin"&&!bandDefaultReady)message("band-default-status","Default setting is unavailable. Complete the database update first.",true);
      }
      const {data,error}=snapshot;
      if(error)throw Error("BAND storage unavailable");
      if(!data){if(scope==="home"){bandHomeSnapshot=null;syncBandMonthChoices([]);}el("band-"+scope+"-events").replaceChildren();el("band-"+scope+"-synced").textContent="";message("band-"+scope+"-status","BAND events have not been synced yet.");}
      else renderBandEvents(scope,upcomingBandEvents(data.events),data.refreshed_at);
      if(scope==="home"&&allowAuto&&(!data||!Number.isFinite(Date.parse(data.refreshed_at))||Date.now()-Date.parse(data.refreshed_at)>=15*60*1000)){
        // Cached cards stay visible during the request; server enforces age and a shared lease.
        const previous=data?.refreshed_at??null;
        try{
          const {data:result,error:syncError}=await client.functions.invoke("band-events-refresh",{body:{unit_id:unit,mode:"auto"}});
          if(!valid())return;
          if(syncError)throw Error("Automatic sync failed");
          if(result?.status==="updated"||result?.status==="cached"){await loadBand(ticket,false);return;}
          if(result?.status==="busy"){
            for(let attempt=0;attempt<5;attempt++){
              await new Promise(resolve=>setTimeout(resolve,2000));
              if(!valid())return;
              const {data:latest,error:readError}=await client.from("toolbox_band_events").select("events,refreshed_at").eq("unit_id",unit).maybeSingle();
              if(!valid())return;
              if(readError)break;
              if(latest&&latest.refreshed_at!==previous){renderBandEvents(scope,upcomingBandEvents(latest.events),latest.refreshed_at);return;}
            }
            if(valid())message("band-home-status",data?"Calendar sync in progress. Showing the last synced events.":"Calendar sync in progress. Reopen Home to check again.");
          }else if(result?.status==="backoff"){
            message("band-home-status",data?"Showing the last synced events; BAND refresh will retry on a later visit.":"BAND is temporarily unavailable. Reopen Home in a few minutes.");
          }else throw Error("Unexpected sync response");
        }catch{if(valid())message("band-home-status",data?"Unable to sync BAND right now. Showing the last synced events.":"Unable to retrieve upcoming events. Try reopening Home later.",true);}
      }
    }catch{if(valid())message("band-"+scope+"-status","Upcoming events are currently unavailable.",true);}
  }
  el("band-refresh").addEventListener("click",async()=>{
    if(!bandCanRefresh||!adminUnit||adminUnit!==bandUnit||bandBusy||el("band-admin-panel").hidden)return;
    const unit=bandUnit,ticket=generation,valid=()=>ticket===generation&&unit===bandUnit&&!el("band-admin-panel").hidden;
    bandBusy=true;el("band-refresh").disabled=true;
    message("band-admin-status","Syncing events from BAND…");
    try{
      const {data,error}=await client.functions.invoke("band-events-refresh",{body:{unit_id:unit,mode:"force"}});
      if(ticket!==generation||unit!==bandUnit)return;
      if(error){
        let reason="";
        try{reason=(await error.context?.json())?.error||"";}catch{}
        if(valid())message("band-admin-status",typeof reason==="string"&&reason.length<240&&reason?reason:"Unable to sync BAND events. Previous events are retained.",true);
        return;
      }
      if(data?.status==="busy"){if(valid())message("band-admin-status","A calendar sync is already in progress. Reopen this page or retry shortly.");return;}
      if(data?.status!=="updated"||!data?.refreshed_at)throw Error("Sync failed");
      if(valid())await loadBand(ticket,false);
    }catch{if(valid())message("band-admin-status","Unable to sync BAND events. Previous events are retained.",true);}
    finally{if(ticket===generation&&unit===bandUnit){bandBusy=false;el("band-refresh").disabled=!bandCanRefresh;}}
  });

  function calendarAdminMode(){return calendarCanRefresh&&!!adminUnit&&adminUnit===calendarUnit&&!el("admin-navigation").hidden;}
  function syncCalendarControls(){
    const visible=calendarAdminMode();
    el("troop-calendar-refresh").hidden=!visible;
    el("troop-calendar-source-settings").hidden=!visible;
    for(const id of ["troop-calendar-refresh","troop-calendar-source-url","troop-calendar-test","troop-calendar-save"])el(id).disabled=calendarBusy;
  }
  function resetTroopCalendar(){
    calendarLoad++;calendarUnit=null;calendarCanRefresh=false;calendarBusy=false;calendarData=null;calendarSavedSource="";
    el("troop-calendar-source-settings").hidden=true;el("troop-calendar-source-url").value="";message("troop-calendar-source-status","");
    el("troop-calendar-refresh").hidden=true;el("troop-calendar-reader").hidden=true;
    el("troop-calendar-version").textContent="";el("troop-calendar-title").textContent="";
    el("troop-calendar-grid").replaceChildren();el("troop-calendar-notes").replaceChildren();
    el("troop-calendar-month").replaceChildren(new Option("All months",""));
    message("troop-calendar-status","");
  }
  function renderTroopCalendar(){
    const grid=el("troop-calendar-grid");grid.replaceChildren();
    if(!calendarData)return;
    const selected=el("troop-calendar-month").value;
    for(const m of calendarData.months.filter(m=>!selected||selected===m.month_key)){
      const card=document.createElement("section");card.className="troop-month-card";
      const heading=document.createElement("h3");heading.textContent=m.heading;card.append(heading);
      const body=document.createElement("div");body.className="troop-month-body";
      const table=document.createElement("table");table.className="troop-month-days";table.setAttribute("aria-label",m.heading+" calendar");
      const head=document.createElement("thead"),week=document.createElement("tr");
      for(const day of m.weekdays){const th=document.createElement("th");th.scope="col";th.textContent=day;week.append(th);}
      head.append(week);table.append(head);
      const tbody=document.createElement("tbody");
      for(let i=0;i<42;i+=7){
        if(!m.days.slice(i,i+7).some(Boolean))continue;
        const tr=document.createElement("tr");
        for(const day of m.days.slice(i,i+7)){const td=document.createElement("td");td.textContent=day;tr.append(td);}
        tbody.append(tr);
      }
      table.append(tbody);body.append(table);
      const agenda=document.createElement("div");agenda.className="troop-month-agenda";
      if(m.meetings){const p=document.createElement("p");p.className="troop-month-meetings";p.textContent=m.meetings;agenda.append(p);}
      for(const event of m.events){
        const row=document.createElement("div");row.className="troop-month-event";
        const date=document.createElement("span");date.className="troop-month-date";date.textContent=event.dates||"TBD";
        const name=document.createElement("span");name.textContent=event.description;
        row.append(date,name);agenda.append(row);
      }
      body.append(agenda);card.append(body);grid.append(card);
    }
  }
  async function loadTroopCalendar(ticket){
    const unit=calendarUnit,call=++calendarLoad,valid=()=>ticket===generation&&call===calendarLoad&&unit===calendarUnit&&!el("troop-calendar-panel").hidden;
    if(!unit||!valid())return;
    message("troop-calendar-status","Loading calendar…");
    try{
      const {data,error}=await client.from("toolbox_troop_calendar").select("source_url,title,calendar_data,source_modified_at,refreshed_at").eq("unit_id",unit).maybeSingle();
      if(!valid())return;
      if(error)throw Error("Calendar unavailable");
      calendarSavedSource=data?.source_url||"";
      el("troop-calendar-source-url").value=calendarSavedSource;
      el("troop-calendar-reader").hidden=!data;el("troop-calendar-version").textContent="";
      if(!data){calendarData=null;message("troop-calendar-status",calendarAdminMode()?"No calendar imported yet. Use Sync Calendar from Google Drive.":"The troop calendar has not been imported yet.");return;}
      const cal=data.calendar_data;
      if(!cal||!Array.isArray(cal.months)||cal.months.length!==12||!Array.isArray(cal.notes)||cal.months.some(m=>typeof m.heading!=="string"||typeof m.month_key!=="string"||!Array.isArray(m.weekdays)||m.weekdays.length!==7||!Array.isArray(m.days)||m.days.length!==42||!Array.isArray(m.events)))throw Error("Invalid calendar");
      calendarData=cal;
      const selector=el("troop-calendar-month"),previous=selector.value;
      selector.replaceChildren(new Option("All months",""),...cal.months.map(m=>new Option(m.heading,m.month_key)));
      if(cal.months.some(m=>m.month_key===previous))selector.value=previous;
      el("troop-calendar-title").textContent=data.title;
      el("troop-calendar-version").textContent="Source modified "+new Date(data.source_modified_at).toLocaleString()+" • Imported "+new Date(data.refreshed_at).toLocaleString();
      const notes=el("troop-calendar-notes");notes.replaceChildren();for(const note of cal.notes){const p=document.createElement("p");p.textContent=note;notes.append(p);}
      message("troop-calendar-status","");renderTroopCalendar();
    }catch{if(valid()){el("troop-calendar-reader").hidden=true;el("troop-calendar-version").textContent="";message("troop-calendar-status","Calendar storage is unavailable. Complete database setup or reopen this page.",true);}}
  }
  el("troop-calendar-month").addEventListener("change",renderTroopCalendar);
function parseSource(value) {
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
    async function runCalendarRefresh(mode){
    if(!calendarAdminMode()||calendarBusy||el("troop-calendar-panel").hidden)return;
    const candidate=el("troop-calendar-source-url").value.trim(),unit=calendarUnit,ticket=generation;
    if(mode!=="refresh"){
      try{parseSource(candidate);}catch{message("troop-calendar-source-status","Paste a valid Google Sheets share link.",true);return;}
      if(mode==="replace"&&!window.confirm("Import this calendar and replace the currently displayed annual calendar if validation succeeds?"))return;
    }else if(candidate!==calendarSavedSource){
      message("troop-calendar-source-status","The URL has changed. Use Test Connection, then Save Source & Update to switch calendars.",true);return;
    }
    const valid=()=>ticket===generation&&unit===calendarUnit&&!el("troop-calendar-panel").hidden;
    calendarBusy=true;syncCalendarControls();
    message("troop-calendar-source-status",mode==="test"?"Testing calendar connection…":"");
    if(mode!=="test")message("troop-calendar-status","Syncing calendar from Google Drive…");
    try{
      const body={unit_id:unit,mode};
      if(mode!=="refresh")body.source_url=candidate;
      const {data,error}=await client.functions.invoke("troop-calendar-refresh",{body});
      if(ticket!==generation||unit!==calendarUnit)return;
      if(error)throw Error("Refresh failed");
      if(mode==="test"){
        if(!data?.title||data.month_count!==12)throw Error("Test failed");
        if(valid())message("troop-calendar-source-status","Connection successful: "+data.title+" (12 months). Nothing has been changed.");
      }else{
        if(!data?.refreshed_at||!data?.source_url)throw Error("Refresh failed");
        if(valid()){
          await loadTroopCalendar(ticket);
          if(valid()&&calendarAdminMode()&&mode==="replace"&&calendarSavedSource===data.source_url)message("troop-calendar-source-status","New source saved and calendar updated.");
        }
      }
    }catch{
      if(valid())message(mode==="test"?"troop-calendar-source-status":"troop-calendar-status",mode==="test"?"Connection failed. Check sharing permissions, the calendar tab and the annual layout.":"Unable to update from Google Sheets. Check the source and permissions. The previous calendar is retained.",true);
    }finally{if(ticket===generation&&unit===calendarUnit){calendarBusy=false;syncCalendarControls();}}
  }
  el("troop-calendar-source-url").addEventListener("input",()=>message("troop-calendar-source-status",""));
  el("troop-calendar-refresh").addEventListener("click",()=>void runCalendarRefresh("refresh"));
  el("troop-calendar-test").addEventListener("click",()=>void runCalendarRefresh("test"));
  el("troop-calendar-save").addEventListener("click",()=>void runCalendarRefresh("replace"));

  function bylawsAdminMode(){return bylawsCanRefresh&&!!adminUnit&&adminUnit===bylawsUnit&&!el("admin-navigation").hidden;}
  function syncBylawsControls(){
    el("bylaws-refresh").hidden=!bylawsAdminMode();
    el("bylaws-refresh").disabled=bylawsBusy;
  }
  function resetBylaws(){
    bylawsLoad++;bylawsUnit=null;bylawsCanRefresh=false;bylawsBusy=false;bylawsData=null;
    el("bylaws-refresh").hidden=true;
    el("bylaws-reader").hidden=true;el("bylaws-search").value="";el("bylaws-version").textContent="";
    el("bylaws-toc").replaceChildren();el("bylaws-content").replaceChildren();el("bylaws-count").textContent="";
    message("bylaws-status","");
  }
  function splitBylaws(text){
    const lines=text.replace(/\r\n?/g,"\n").split("\n");
    const start=lines.reduce((i,l,n)=>/^\s*1\.\s+Introduction\s*$/i.test(l)?n:i,-1);
    // Omit duplicate cover/contents only if the numbered main body is present.
    const sections=[];let current={heading:"Document",lines:[]};
    for(const line of lines.slice(start<0?0:start)){
      if(/^\s*[1-9]\.\s+\S/.test(line)&&line.length<180){
        if(current.lines.length||current.heading!=="Document")sections.push(current);
        current={heading:line.trim(),lines:[]};
      }else current.lines.push(line);
    }
    if(current.lines.length||current.heading!=="Document")sections.push(current);
    return sections;
  }
  function highlightedText(node,text,query){
    if(!query){node.append(document.createTextNode(text));return;}
    const needle=query.toLowerCase(),hay=text.toLowerCase();let from=0,i;
    while((i=hay.indexOf(needle,from))!==-1){
      node.append(document.createTextNode(text.slice(from,i)));
      const mark=document.createElement("mark");mark.textContent=text.slice(i,i+needle.length);node.append(mark);from=i+needle.length;
    }
    node.append(document.createTextNode(text.slice(from)));
  }
  function renderBylaws(){
    const toc=el("bylaws-toc"),content=el("bylaws-content");toc.replaceChildren();content.replaceChildren();
    if(!bylawsData)return;
    const query=el("bylaws-search").value.trim().toLowerCase(),sections=splitBylaws(bylawsData.body_text);
    const matching=sections.filter(s=>!query||[s.heading,...s.lines].join("\n").toLowerCase().includes(query));
    el("bylaws-count").textContent=query?matching.length+" matching section"+(matching.length===1?"":"s"):"";
    for(const [index,s] of matching.entries()){
      const section=document.createElement("section"),heading=document.createElement("h3");
      section.id="bylaws-section-"+index;highlightedText(heading,s.heading,query);section.append(heading);
      const link=document.createElement("button");link.type="button";link.className="secondary";link.textContent=s.heading;
      link.addEventListener("click",()=>section.scrollIntoView({block:"start",behavior:"smooth"}));toc.append(link);
      for(const line of s.lines){
        if(!line.trim())continue;
        const sub=/^\s*[1-9](?:\.\d+)+\.?\s+\S/.test(line)&&line.length<180;
        const p=document.createElement(sub?"h4":"p");highlightedText(p,line,query);section.append(p);
      }
      content.append(section);
    }
    if(!matching.length){const p=document.createElement("p");p.textContent="No matching sections. Try a shorter keyword.";content.append(p);}
  }
  async function loadBylaws(ticket){
    const unit=bylawsUnit,call=++bylawsLoad,valid=()=>ticket===generation&&call===bylawsLoad&&unit===bylawsUnit&&!el("bylaws-panel").hidden;
    if(!unit||!valid())return;
    message("bylaws-status","Loading bylaws…");
    try{
      const {data,error}=await client.from("toolbox_bylaws").select("title,body_text,source_modified_at,refreshed_at").eq("unit_id",unit).maybeSingle();
      if(!valid())return;
      if(error)throw Error("Bylaws unavailable");
      bylawsData=data;
      el("bylaws-reader").hidden=!data;el("bylaws-version").textContent="";
      if(!data){message("bylaws-status",bylawsAdminMode()?"No bylaws imported yet. Use Sync Bylaws from Google Drive to import the document.":"The bylaws have not been imported yet.");return;}

      const draft=/working draft|pending troop committee approval/i.test(data.body_text);
      el("bylaws-version").textContent=(draft?"Working Draft — Pending Troop Committee Approval • ":"")+"Source modified "+new Date(data.source_modified_at).toLocaleString()+" • Imported "+new Date(data.refreshed_at).toLocaleString();
      message("bylaws-status","");renderBylaws();
    }catch{
      if(valid()){el("bylaws-reader").hidden=true;el("bylaws-version").textContent="";message("bylaws-status","Bylaws storage is unavailable. Complete the database setup or reopen this page.",true);}
    }
  }
  el("bylaws-search").addEventListener("input",renderBylaws);
  el("bylaws-refresh").addEventListener("click",async()=>{
    if(!bylawsAdminMode()||bylawsBusy||el("bylaws-panel").hidden)return;
    const unit=bylawsUnit,ticket=generation;
    const valid=()=>ticket===generation&&unit===bylawsUnit&&!el("bylaws-panel").hidden;
    bylawsBusy=true;syncBylawsControls();message("bylaws-status","Syncing bylaws from Google Drive…");
    try{
      const {data,error}=await client.functions.invoke("bylaws-refresh",{body:{unit_id:unit}});
      if(ticket!==generation||unit!==bylawsUnit)return;
      if(error||!data?.refreshed_at)throw Error("Refresh failed");
      if(valid()){el("bylaws-search").value="";await loadBylaws(ticket);}
    }catch{if(valid())message("bylaws-status","Unable to sync bylaws from Google Drive. Check the server connection and document permissions. Any existing snapshot is retained.",true);}
    finally{if(ticket===generation&&unit===bylawsUnit){bylawsBusy=false;syncBylawsControls();}}
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
      .select("id,name,slug").eq("slug","troop-120").maybeSingle();
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
    message("workspace-status","");
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

    el("troop-sidebar").hidden=false;
    el("family-navigation").hidden=false;
    addNav("overview-panel","Home","navigation","home");
    el("brand-home").disabled=false;
    for(const tool of troopTools)addPlanned(tool,"navigation");
    bandUnit=unit.id;bandCanRefresh=ownRoles.includes("admin")&&member.member_type==="adult"&&unit.slug==="troop-120";
    calendarUnit=unit.id;calendarCanRefresh=ownRoles.includes("admin")&&member.member_type==="adult"&&unit.slug==="troop-120";
    bylawsUnit=unit.id;bylawsCanRefresh=ownRoles.includes("admin")&&member.member_type==="adult"&&unit.slug==="troop-120";
    photosUnit=unit.id;photosCanAdd=ownRoles.includes("admin")&&member.member_type==="adult";
    syncPhotoHeaderActions();
    if(ownRoles.includes("parent") && member.member_type==="adult") {
      familyUnit=unit.id;
      addNav("my-scouts-panel","My Scouts","family-navigation","people");
    }
    for(const tool of personalTools)addPlanned(tool,"family-navigation");
    openPanel("overview-panel");
    if (ticket !== generation) return;

    if (ownRoles.includes("admin") && member.member_type === "adult") {
      adminUnit = unit.id;
      addNav("admin-panel","Administration","account-navigation","shield",null,"admin");
      addNav("admin-panel","Accounts & Members","admin-navigation","people",null,"admin");
      addNav("photos-panel","Pictures & Albums","admin-navigation","image",null,"admin");
      addNav("bylaws-panel","Bylaws","admin-navigation","book",null,"admin");
      addNav("troop-calendar-panel","Troop Calendar","admin-navigation","calendar",null,"admin");
      addNav("band-admin-panel","BAND Integration","admin-navigation","calendar",null,"admin");
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
