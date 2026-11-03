// Sign up, log in, forgot password, reset password and confirm email.
(function () {
  const { $, api, show, boot } = App;
  const msg = $("#msg");
  const busy = (form, on) => form.querySelectorAll("button").forEach((b) => (b.disabled = on));
  const page = document.body.dataset.page;
  // Only a path on this site: "//host" or "/\\host" would leave it, so the second character can't be a slash.
  const next = () => { const n = new URLSearchParams(location.search).get("next"); return n && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9/_-]*)?$/.test(n) && !n.includes("//") ? n : "/dashboard"; };

  boot().then((d) => { if (d.user && (page === "login" || page === "signup")) location.replace(next()); });

  const form = $("form");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    show(msg, "", "");
    const f = Object.fromEntries(new FormData(form));
    busy(form, true);
    let r;
    if (page === "signup") {
      if (f.password !== f.password2) { show(msg, "error", "The two passwords don't match."); busy(form, false); return; }
      r = await api("/api/signup", { name: f.name, email: f.email, password: f.password, consent: !!f.consent, website: f.website });
      if (r.ok) { location.href = next(); return; }
    } else if (page === "login") {
      r = await api("/api/login", { email: f.email, password: f.password });
      if (r.ok) { location.href = next(); return; }
    } else if (page === "forgot") {
      r = await api("/api/forgot", { email: f.email, website: f.website });
      if (r.ok) { form.hidden = true; show(msg, "ok", "If that email has an account, we've sent a link to reset the password. It works for one hour."); return; }
    } else if (page === "reset") {
      if (f.password !== f.password2) { show(msg, "error", "The two passwords don't match."); busy(form, false); return; }
      r = await api("/api/reset", { token: new URLSearchParams(location.search).get("token") || "", password: f.password });
      if (r.ok) { location.href = "/dashboard"; return; }
    }
    show(msg, "error", (r && r.data.error) || "Something went wrong.");
    busy(form, false);
  });

  if (page === "verify") {
    const token = new URLSearchParams(location.search).get("token") || "";
    api("/api/verify", { token }).then((r) => {
      if (r.ok) { show(msg, "ok", "Thanks, your email is confirmed."); $("#next").hidden = false; }
      else { show(msg, "error", r.data.error || "That link didn't work."); $("#next").hidden = false; }
    });
  }
})();
