"use strict";
const SUPABASE_URL = "https://vionsmadqxigjmygqtoe.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_JNtssN1rIQknWgW4oQhxNA_yMWPlH5Y";
const REDIRECT_URL = "https://bsatroop120.github.io/troop120-toolbox/";
const el = id => document.getElementById(id);
const label = code => ({admin:"Administrator",leader:"Adult leader",parent:"Parent or guardian",scout:"Scout"}[code] || code);
function message(id, text, error = false) {
  el(id).textContent = text;
  el(id).dataset.error = String(error);
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
    title.textContent = label(row.requested_role) + " — " + row.status;
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

  function clearWorkspace() {
    currentUser = null;
    busy = false;
    el("navigation").replaceChildren();
    for (const id of ["account-email","role-status","workspace-status","request-message","own-requests","admin-requests"]) el(id).textContent = "";
    for (const id of ["member-count","patrol-count","role-count"]) el(id).textContent = "—";
    for (const id of ["access-panel","overview-panel","admin-panel","workspace"]) el(id).hidden = true;
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
  function openPanel(id) {
    for (const p of ["access-panel","overview-panel","admin-panel"]) el(p).hidden = p !== id;
    for (const b of el("navigation").querySelectorAll("button")) {
      if (b.dataset.panel === id) b.setAttribute("aria-current","page");
      else b.removeAttribute("aria-current");
    }
  }
  function addNav(id, text) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.panel = id;
    b.textContent = text;
    b.addEventListener("click", () => openPanel(id));
    el("navigation").append(b);
  }
  async function loadOwnRequests(userId, ticket) {
    const {data,error} = await client.from("access_requests")
      .select("requested_role,status,requested_at").eq("profile_id",userId)
      .order("requested_at",{ascending:false}).limit(50);
    if (ticket !== generation) return;
    showRequests("own-requests", data || [], error ? "Unable to load requests." : "No requests submitted.");
  }
  async function render(session) {
    if (!session) { signedOut("Ready to sign in."); return; }
    const ticket = ++generation;
    clearWorkspace();
    el("main").classList.add("workspace");
    el("login-card").hidden = true;
    el("workspace").hidden = false;
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

    const {data:roles,error:roleError} = await client.from("user_roles")
      .select("unit_id,role_code").eq("profile_id",user.id);
    if (ticket !== generation) return;
    if (roleError) {
      message("workspace-status","Sign-in verified, but role check failed.",true);
      return;
    }
    // The account request workflow is available even without unit access.
    addNav("access-panel","My access");
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
    addNav("overview-panel","Overview");
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
      const {data:requests,error} = await client.from("access_requests")
        .select("requested_role,status,requested_at").eq("unit_id",unit.id)
        .order("requested_at",{ascending:false}).limit(50);
      if (ticket !== generation) return;
      showRequests("admin-requests", requests || [],error ? "Unable to load requests." : "No account requests.");
      addNav("admin-panel","Administration");
    }
  }

  el("request-form").addEventListener("submit",async event => {
    event.preventDefault();
    if (!currentUser || busy) return;
    const ticket = generation;
    const name = el("display-name").value.trim();
    const role = el("requested-role").value;
    if (!name || name.length > 100 || !["parent","leader","scout"].includes(role)) {
      message("request-message","Enter a test display name and select a role.",true);
      return;
    }
    busy = true;
    el("request-submit").disabled = true;
    message("request-message","Submitting...");
    try {
      const {error} = await client.rpc("request_toolbox_access",{p_display_name:name,p_requested_role:role});
      if (ticket !== generation) return;
      if (error) {
        message("request-message",error.message === "Role already assigned" ? "This role is already assigned to your account." : "Request could not be submitted. Try again.",true);
        return;
      }
      el("request-form").reset();
      message("request-message","Request recorded. Administrator review is required.");
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
    currentUser = null;
    for (const id of ["access-panel","overview-panel","admin-panel"]) el(id).hidden = true;
    el("navigation").replaceChildren();
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
