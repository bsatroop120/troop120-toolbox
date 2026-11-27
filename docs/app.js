"use strict";

// Public browser configuration. Never substitute a secret or service-role key.
const SUPABASE_URL = "https://vionsmadqxigjmygqtoe.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_JNtssN1rIQknWgW4oQhxNA_yMWPlH5Y";
const REDIRECT_URL = "https://bsatroop120.github.io/troop120-toolbox/";

const el = (id) => document.getElementById(id);
const status = (message, error = false) => {
  el("status").textContent = message;
  el("status").dataset.error = String(error);
};

async function start() {
  if (!window.supabase?.createClient) {
    status("Authentication library could not load. Refresh the page and try again.", true);
    return;
  }

  // Use a per-tab session for the initial test, not shared localStorage.
  const client = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: {
      flowType: "pkce",
      storage: window.sessionStorage,
      storageKey: "troop120-toolbox-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  let generation = 0;
  function showSignedOut(message, error = false) {
    generation++;
    el("signed-in").hidden = true;
    el("account-email").textContent = "";
    el("role-status").textContent = "";
    el("signed-out").hidden = false;
    el("google-sign-in").disabled = false;
    status(message, error);
  }

  async function render(session) {
    if (!session) {
      showSignedOut("Ready to sign in.");
      return;
    }
    const current = ++generation;
    el("signed-out").hidden = true;
    el("signed-in").hidden = false;
    el("sign-out").disabled = false;
    el("account-email").textContent = "Verifying account...";
    el("role-status").textContent = "";
    status("Checking authentication and permissions...");

    // Verify the account with the Auth service before querying its roles.
    const { data: userData, error: userError } = await client.auth.getUser();
    if (current !== generation) return;
    if (userError || !userData?.user) {
      el("account-email").textContent = "Account not verified";
      status("Unable to verify this session. Sign out and try again.", true);
      return;
    }
    const user = userData.user;
    el("account-email").textContent = user.email || "Verified account";

    // Request only the signed-in account's own roles. Database RLS is authoritative.
    const { data: roles, error: roleError } = await client
      .from("user_roles")
      .select("role_code")
      .eq("profile_id", user.id);
    if (current !== generation) return;
    if (roleError) {
      el("role-status").textContent = "Role check unavailable.";
      status("Sign-in verified, but the database role check failed.", true);
      return;
    }
    const labels = [...new Set((roles || []).map((r) => r.role_code))];
    el("role-status").textContent = labels.length
      ? "Assigned roles: " + labels.join(", ")
      : "No assigned roles. Troop access has not been granted.";
    status("Authentication verified. Database role check successful.");
  }

  el("google-sign-in").addEventListener("click", async () => {
    el("google-sign-in").disabled = true;
    status("Opening Google sign-in...");
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: REDIRECT_URL }
      });
      if (error) throw error;
    } catch {
      showSignedOut("Google sign-in could not start. Try again.", true);
    }
  });

  el("sign-out").addEventListener("click", async () => {
    ++generation;
    el("sign-out").disabled = true;
    status("Signing out...");
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      showSignedOut("Signed out.");
    } catch {
      el("sign-out").disabled = false;
      status("Sign-out failed. Try again before leaving this computer.", true);
    }
  });

  // Run asynchronous operations outside the Auth state-change callback.
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      showSignedOut("Signed out.");
    }
  });

  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const callbackError = query.has("error") || fragment.has("error");
  const callbackCode = query.has("code");
  const { data, error } = await client.auth.getSession();
  if (callbackError || error || (callbackCode && !data?.session)) {
    if (callbackError || callbackCode) history.replaceState(null, "", location.pathname);
    showSignedOut("Sign-in did not complete. Use an authorized test account and try again.", true);
    return;
  }
  await render(data?.session);
}

start().catch(() => status("Unable to initialize the Toolbox. Refresh the page and try again.", true));
