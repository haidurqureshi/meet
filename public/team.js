// Accepting an invitation to a Business team: /team?token=...
(function () {
  const { $, api, show, boot, busy } = App;
  const KEY = "meet-team-token";
  // Keep the token for this tab and take it out of the address bar, so it survives logging in or signing up.
  let token = new URLSearchParams(location.search).get("token") || "";
  try {
    if (token) { sessionStorage.setItem(KEY, token); history.replaceState(null, "", "/team"); }
    else token = sessionStorage.getItem(KEY) || "";
  } catch { /* storage blocked */ }
  const actions = $("#tactions");
  const btn = (label, cls, href) => { const a = document.createElement(href ? "a" : "button"); a.textContent = label; a.className = href ? "btn " + cls : cls; if (href) a.href = href; actions.append(a); return a; };
  const done = () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } };

  (async () => {
    const d = await boot();
    if (!token) { $("#ttext").textContent = "Open the link from your invitation email."; return; }
    const r = await api("/api/team/peek", { token });
    if (!r.ok) { $("#ttext").textContent = ""; show($("#msg"), "error", r.data.error || "This invitation isn't valid."); done(); return; }
    $("#ttitle").textContent = `Join ${r.data.ownerName}'s team`;
    $("#ttext").textContent = `${r.data.ownerName} invited ${r.data.email} to their team. You'll get the Business plan on your own account, at no cost to you.`;
    actions.hidden = false;
    if (!d.user) {
      btn("Create an account", "primary", "/signup?next=/team");
      btn("I have an account", "", "/login?next=/team");
      return;
    }
    const b = btn(`Join as ${d.user.name}`, "primary");
    b.onclick = async () => {
      busy(b, true);
      const a = await api("/api/team/accept", { token });
      busy(b, false);
      if (!a.ok) return show($("#msg"), "error", a.data.error || "Something went wrong.");
      done();
      location.href = "/dashboard";
    };
  })();
})();
