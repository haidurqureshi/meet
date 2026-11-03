// Shared helpers for every page. No framework, no build step.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  async function api(path, body, method) {
    const opts = { method: method || (body === undefined ? "GET" : "POST"), headers: {} , credentials: "same-origin" };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); } catch { return { ok: false, status: 0, data: { error: "Can't reach the server. Check your connection." } }; }
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, data };
  }

  function show(el, kind, text) {
    if (!el) return;
    el.className = kind;
    el.textContent = text || "";
    el.hidden = !text;
  }

  async function me() {
    const r = await api("/api/me");
    return r.ok ? r.data : { user: null, appName: "Meet", price: "" };
  }

  // Fills in {app} placeholders and the nav.
  async function boot() {
    const d = await me();
    document.querySelectorAll("[data-app]").forEach((e) => (e.textContent = d.appName));
    document.querySelectorAll("[data-price]").forEach((e) => (e.textContent = d.price));
    const nav = $("#nav");
    if (nav) {
      nav.textContent = "";
      const add = (href, label) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.className = "navlink"; nav.append(a); };
      if (d.user) { add("/dashboard", "Dashboard"); } else { add("/login", "Log in"); add("/signup", "Sign up"); }
    }
    return d;
  }

  async function logout() { await api("/api/logout", {}); location.href = "/"; }

  // Accepts a full link, /m/code or a bare code.
  function roomCode(text) {
    const m = /(?:^|\/m\/|\/)([a-z2-9]{12})\/?(?:[?#].*)?$/.exec(String(text).trim());
    return m ? m[1] : null;
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select();
      try { document.execCommand("copy"); } catch { /* ignore */ } t.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = old), 1500); }
  }

  window.App = { $, api, show, me, boot, logout, roomCode, copy };
})();
