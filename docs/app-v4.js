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
  let adminUnit = null;
  let adminBusy = false;
  let adminLoaded = false;

  function clearWorkspace() {
    currentUser = null;
    busy = false;
    adminUnit = null;
    adminBusy = false;
    adminLoaded = false;
    el("member-form").reset();
    el("member-create").disabled = false;
    el("admin-refresh").disabled = false;
    for (const id of ["admin-message","member-message","lifecycle-message","admin-members"]) el(id).textContent = "";
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
  function setAdminBusy(value) {
    adminBusy = value;
    el("member-create").disabled = value;
    el("admin-refresh").disabled = value;
    for (const control of el("admin-panel").querySelectorAll("button,select,input")) {
      control.disabled = value || control.dataset.unavailable === "true";
    }
  }

  async function loadAdmin(ticket) {
    if (ticket !== generation || !adminUnit) return false;
    adminLoaded = false;
    const unit = adminUnit;
    el("admin-requests").replaceChildren();
    el("admin-members").replaceChildren();
    const [requests,members,links,roles] = await Promise.all([
      client.rpc("list_toolbox_access_requests",{p_unit_id:unit}),
      client.from("members").select("id,display_name,member_type,active",{count:"exact"}).eq("unit_id",unit).order("display_name").limit(500),
      client.from("member_accounts").select("member_id,profile_id",{count:"exact"}).eq("unit_id",unit).limit(500),
      client.from("user_roles").select("profile_id,role_code",{count:"exact"}).eq("unit_id",unit).limit(500)
    ]);
    if (ticket !== generation || adminUnit !== unit) return false;
    if (requests.error || members.error || links.error || roles.error) {
      message("admin-message","Unable to load administrative records. Check access and refresh.",true);
      return false;
    }
    // Fail closed if any roster/role result is incomplete.
    if ([members,links,roles].some(r => r.count === null || r.count !== (r.data || []).length)) {
      message("admin-message","Administrative record limit reached. Management is disabled until pagination is implemented.",true);
      return false;
    }
    const roster = members.data || [];
    const linkMap = new Map((links.data || []).map(row=>[row.member_id,row.profile_id]));
    const linked = new Set(linkMap.keys());
    const rolesByProfile = new Map();
    for (const row of roles.data || []) {
      if (!rolesByProfile.has(row.profile_id)) rolesByProfile.set(row.profile_id,[]);
      rolesByProfile.get(row.profile_id).push(row.role_code);
    }
    el("member-count").textContent = String(roster.length);
    for (const m of roster) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = m.display_name;
      const detail = document.createElement("span");
      detail.textContent = (m.member_type === "adult" ? "Adult" : "Scout") + " · " + (m.active ? "Active" : "Inactive") + " · " + (linked.has(m.id) ? "Account linked" : "No account linked");
      const profileId = linkMap.get(m.id);
      const assigned = rolesByProfile.get(profileId) || [];
      const protectedMember = profileId === currentUser || assigned.includes("admin");
      const roleText = document.createElement("p");
      roleText.className = "small";
      roleText.textContent = "Assigned roles: " + (assigned.length ? assigned.map(label).join(", ") : "None");
      li.append(title,detail,roleText,memberTools(m,assigned,protectedMember,ticket));
      el("admin-members").append(li);
    }
    if (!roster.length) el("admin-members").textContent = "No member records.";
    for (const row of requests.data || []) {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = (row.applicant_name || "Unnamed applicant") + " — " + label(row.requested_role) + " — " + row.request_status;
      const email = document.createElement("span");
      email.className = "request-email";
      email.textContent = (row.applicant_email || "No email") + (row.email_verified ? " · Verified email" : " · Email not verified");
      const detail = document.createElement("span");
      detail.textContent = "Requested " + new Date(row.requested_at).toLocaleString();
      li.append(title,email,detail);
      if (row.request_status === "pending") {
        const box = document.createElement("div");
        box.className = "review-controls";
        const actions = document.createElement("div");
        actions.className = "actions";
        const deny = document.createElement("button");
        deny.type = "button";
        deny.className = "danger";
        deny.textContent = "Deny request";
        deny.addEventListener("click",()=>review(row,false,null,ticket));
        if (row.requested_role === "leader" && row.email_verified) {
          const field = document.createElement("div");
          field.className = "field";
          const select = document.createElement("select");
          const title = document.createElement("label");
          select.id = "review-" + row.request_id;
          title.htmlFor = select.id;
          title.textContent = "Associate with adult member";
          select.append(new Option("Choose an active adult member",""));
          for (const m of roster) {
            if (m.active && m.member_type === "adult" &&
                (row.linked_member_id ? m.id === row.linked_member_id : !linked.has(m.id))) {
              select.append(new Option(m.display_name + " · " + m.id.slice(0,8),m.id));
            }
          }
          field.append(title,select);
          box.append(field);
          const checkLabel = document.createElement("label");
          checkLabel.className = "check";
          const check = document.createElement("input");
          check.type = "checkbox";
          checkLabel.append(check,document.createTextNode("I verified the account and selected the correct test member."));
          box.append(checkLabel);
          const approve = document.createElement("button");
          approve.type = "button";
          approve.textContent = "Approve leader";
          approve.addEventListener("click",()=>{
            if (!select.value || !check.checked) {
              message("admin-message","Select the correct adult member and confirm verification.",true);
              return;
            }
            review(row,true,select.value,ticket);
          });
          actions.append(approve);
        } else {
          const note = document.createElement("p");
          note.className = "small";
          note.textContent = "Approval is not available for this request in the current test interface.";
          box.append(note);
        }
        actions.append(deny);
        box.append(actions);
        li.append(box);
      }
      el("admin-requests").append(li);
    }
    if (!(requests.data || []).length) el("admin-requests").textContent = "No account requests.";
    adminLoaded = true;
    return true;
  }

  function memberTools(member,assigned,protectedMember,ticket) {
    const box = document.createElement("details");
    box.className = "member-tools";
    const summary = document.createElement("summary");
    summary.textContent = "Manage member";
    box.append(summary);
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
    box.append(field,save);
    if (protectedMember) {
      const note = document.createElement("p");
      note.textContent = "Protected administrator membership. Status and role changes are unavailable.";
      box.append(note);
      return box;
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
        ? "Deactivate " + member.display_name + "? All assigned troop roles will be removed. The member record and account link will be retained."
        : "Reactivate " + member.display_name + "? Roles will NOT be restored automatically.",
      member.active ? "Member deactivated; assigned troop roles removed." : "Member reactivated; a new approval is required for access.",ticket));
    actions.append(active);
    box.append(actions);
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
      box.append(row);
    }
    return box;
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

  async function review(row,approve,memberId,ticket) {
    if (!adminUnit || adminBusy || !adminLoaded || ticket !== generation) return;
    if (!window.confirm((approve ? "Approve" : "Deny") + " this " + label(row.requested_role) + " request for " + (row.applicant_email || "this applicant") + "?")) return;
    setAdminBusy(true);
    message("admin-message","Saving review...");
    try {
      const {error} = await client.rpc("review_toolbox_access",{
        p_request_id:row.request_id,p_approve:approve,p_member_id:memberId
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
      adminUnit = unit.id;
      addNav("admin-panel","Administration");
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
    adminUnit = null;
    adminLoaded = false;
    for (const id of ["admin-requests","admin-members","admin-message","member-message","lifecycle-message"]) el(id).textContent = "";
    el("member-form").reset();
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
