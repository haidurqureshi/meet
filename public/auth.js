// Sign up, log in, forgot password, reset password and confirm email.
(function () {
  const { $, api, show, boot, busy } = App;
  const msg = $("#msg");
  const page = document.body.dataset.page;
  // Only a path on this site: "//host" or "/\host" would leave it, so the second character can't be a slash.
  const next = () => { const n = new URLSearchParams(location.search).get("next"); return n && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9/_-]*)?$/.test(n) && !n.includes("//") ? n : "/dashboard"; };

  boot().then((d) => { if (d.user && (page === "login" || page === "signup")) location.replace(next()); });

  // Switching between log in and sign up keeps where you were going.
  const n = new URLSearchParams(location.search).get("next");
  if (n) document.querySelectorAll("a[data-keep-next]").forEach((a) => { a.href += "?next=" + encodeURIComponent(next()); });

  const form = $("form");
  const fail = (text, field) => {
    show(msg, "error", text);
    if (field && form[field]) { form[field].setAttribute("aria-invalid", "true"); form[field].focus(); }
  };
  if (form) form.addEventListener("input", (e) => { e.target.removeAttribute("aria-invalid"); });

  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    show(msg, "", "");
    const f = Object.fromEntries(new FormData(form));
    const btn = form.querySelector("button.primary");

    // Quick checks before asking the server, so mistakes show straight away.
    if ("email" in f && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.email).trim())) return fail("Please enter a valid email address.", "email");
    if (page === "signup" && !String(f.name).trim()) return fail("Please enter your name.", "name");
    if ((page === "signup" || page === "reset") && String(f.password).length < 8) return fail("Your password needs at least 8 characters.", "password");
    if ((page === "signup" || page === "reset") && f.password !== f.password2) return fail("The two passwords don't match.", "password2");
    if (page === "signup" && !f.consent) return fail("Please tick the box to accept the terms.", "consent");
    if (page === "login" && !f.password) return fail("Please enter your password.", "password");

    busy(btn, true);
    let r;
    if (page === "signup") {
      r = await api("/api/signup", { name: f.name, email: f.email, password: f.password, consent: !!f.consent, website: f.website });
      if (r.ok) { location.href = next(); return; }
    } else if (page === "login") {
      r = await api("/api/login", { email: f.email, password: f.password });
      if (r.ok) { location.href = next(); return; }
    } else if (page === "forgot") {
      r = await api("/api/forgot", { email: f.email, website: f.website });
      if (r.ok) { form.hidden = true; show(msg, "ok", `If ${String(f.email).trim()} has an account, we've sent a link to reset the password. It works for one hour. Check your spam folder if it doesn't arrive.`); msg.hidden = false; form.after(msg); return; }
    } else if (page === "reset") {
      r = await api("/api/reset", { token: new URLSearchParams(location.search).get("token") || "", password: f.password });
      if (r.ok) { location.href = "/dashboard"; return; }
    }
    busy(btn, false);
    show(msg, "error", (r && r.data.error) || "Something went wrong.");
  });

  if (page === "reset" && !new URLSearchParams(location.search).get("token")) {
    form.hidden = true;
    show(msg, "error", "This page needs the link from your password reset email.");
    msg.innerHTML = "";
    msg.append("This page needs the link from your password reset email. ", Object.assign(document.createElement("a"), { href: "/forgot", textContent: "Ask for a new one" }), ".");
    form.after(msg);
  }

  if (page === "verify") {
    const token = new URLSearchParams(location.search).get("token") || "";
    api("/api/verify", { token }).then((r) => {
      $("h1").textContent = r.ok ? "Email confirmed" : "That link didn't work";
      if (r.ok) show(msg, "ok", "Thanks, your email is confirmed. You can now send meeting invitations.");
      else show(msg, "error", r.data.error || "That link didn't work.");
      $("#next").hidden = false;
    });
  }
})();
