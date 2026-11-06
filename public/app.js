// Shared helpers for every page. No framework, no build step.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  async function api(path, body, method) {
    const opts = { method: method || (body === undefined ? "GET" : "POST"), headers: {}, credentials: "same-origin" };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); } catch { return { ok: false, status: 0, data: { error: "Can't reach the server. Check your connection." } }; }
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, data };
  }

  /** Shows a message box (kind "error" or "ok"), or hides it when text is empty. Errors are announced to screen readers. */
  function show(el, kind, text) {
    if (!el) return;
    el.className = kind;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = text || "";
    el.hidden = !text;
  }

  /** A short message at the bottom of the screen that fades away. */
  let toastTimer;
  function toast(text) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /** Disables a button and shows a spinner on it while something is happening. */
  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("busy", on);
    btn.setAttribute("aria-busy", String(on));
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
    document.querySelectorAll("[data-origin]").forEach((e) => (e.textContent = location.origin));
    document.querySelectorAll("[data-signed-in]").forEach((e) => (e.hidden = !d.user));
    document.querySelectorAll("[data-signed-out]").forEach((e) => (e.hidden = !!d.user));
    const nav = $("#nav");
    if (nav) {
      nav.textContent = "";
      const add = (href, label, cls) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.className = cls || "navlink"; if (location.pathname === href) a.setAttribute("aria-current", "page"); nav.append(a); };
      if (d.user) { add("/dashboard", "Dashboard", "btn primary"); } else { add("/login", "Log in"); add("/signup", "Sign up", "btn primary"); }
    }
    return d;
  }

  async function logout() { await api("/api/logout", {}); location.href = "/"; }

  // Accepts a full link, /m/code or a bare code.
  function roomCode(text) {
    const m = /(?:^|\/m\/|\/)([a-z2-9]{12})\/?(?:[?#].*)?$/.exec(String(text).trim().toLowerCase());
    return m ? m[1] : null;
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select();
      try { document.execCommand("copy"); } catch { /* ignore */ } t.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = old), 1500); }
  }

  // "Show" buttons on password fields.
  document.querySelectorAll("input[type=password]").forEach((input) => {
    if (input.closest(".pw")) return;
    const wrap = document.createElement("div");
    wrap.className = "pw";
    input.replaceWith(wrap);
    const b = document.createElement("button");
    b.type = "button"; b.className = "reveal"; b.textContent = "Show";
    b.setAttribute("aria-label", "Show password");
    b.onclick = () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      b.textContent = hidden ? "Hide" : "Show";
      b.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
    };
    wrap.append(input, b);
  });

  window.App = { $, api, show, toast, busy, me, boot, logout, roomCode, copy };
})();
