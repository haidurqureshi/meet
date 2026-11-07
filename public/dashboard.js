(function () {
  const { $, api, show, toast, busy } = App;
  let user = null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  $("#tz").textContent = tz;

  const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); e.append(...kids.filter((k) => k != null)); return e; };
  const fmtDate = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const OPEN_BEFORE = 15 * 60_000;

  /** "in 25 minutes", "in 3 hours", "tomorrow", "in 4 days" */
  function relative(ms) {
    const d = ms - Date.now();
    const min = Math.round(d / 60_000);
    if (min < 60) return `in ${min} minute${min === 1 ? "" : "s"}`;
    const h = Math.round(min / 60);
    if (h < 24) return `in ${h} hour${h === 1 ? "" : "s"}`;
    const days = Math.round(h / 24);
    return days === 1 ? "tomorrow" : `in ${days} days`;
  }

  $("#logout").onclick = App.logout;

  function flash(kind, text) { show($("#flash"), kind, text); if (text) $("#flash").scrollIntoView({ behavior: "smooth", block: "center" }); }

  function renderUser() {
    const first = user.name.split(" ")[0] || user.name;
    $("#who").textContent = user.name;
    $("#hello").textContent = `Hi, ${first}`;
    $("#subhead").textContent = user.subscribed ? "Start a call now, or schedule one and we'll send the invitations." : "Become a host to start and schedule meetings.";
    $("#acctEmail").textContent = `Signed in as ${user.email}`;
    $("#verifyBox").hidden = user.verified;
    $("#vemail").textContent = user.email;
    const url = location.origin + "/m/" + user.personalRoom;
    $("#personalUrl").value = url;
    $("#personalGo").href = "/m/" + user.personalRoom;
    $("#personalCopy").onclick = () => App.copy(url).then(() => toast("Personal room link copied"));

    const b = $("#billingBody");
    b.textContent = "";
    if (user.subscribed) {
      const end = user.periodEnd ? fmtDay(user.periodEnd) : null;
      const isPro = user.plan === "pro";
      b.append(el("p", { className: "billing-status" }, el("span", { className: "pill live" }, isPro ? "Pro" : "Host"), `${isPro ? user.proPrice : user.price}.`, end ? (user.cancelAtEnd ? ` Ends on ${end} (won't renew).` : ` Renews on ${end}.`) : ""));
      if (!isPro) {
        b.append(el("div", { className: "upsell" },
          el("strong", {}, `Upgrade to Pro · ${user.proPrice}`),
          el("p", { className: "small" }, "Your logo and colours instead of ours, your own link (meet…/your-name), a welcome screen with an agenda, and an after-call page for invoices, bookings or feedback. Your Host plan is cancelled and the unused days are credited."),
          el("button", { className: "primary", onclick: upgrade }, "Upgrade to Pro")));
      }
      if (user.hasCustomer) b.append(el("div", { className: "row" }, el("button", { onclick: portal }, "Manage billing or cancel")));
    } else {
      const was = user.subStatus && user.subStatus !== "none";
      if (was) b.append(el("p", { className: "billing-status" }, el("span", { className: "pill" }, user.subStatus === "past_due" ? "Payment failed" : "Inactive"), "Your subscription isn't active, so your meeting links won't open."));
      b.append(el("p", {}, "Choose a plan. Cancel any time. Guests joining your meetings never pay."));
      const plan = (name, price, points, onclick, primary) => el("div", { className: "plan" + (primary ? " plan-pro" : "") },
        el("strong", {}, name), el("div", { className: "plan-price" }, price),
        el("ul", {}, ...points.map((t) => el("li", {}, t))),
        el("button", { className: primary ? "primary" : "", onclick }, `Choose ${name}`));
      b.append(el("div", { className: "plans" },
        plan("Host", user.price, ["Unlimited meetings", "Personal room, instant and scheduled meetings", "Email invitations", "API for your website"], subscribe, false),
        plan("Pro", user.proPrice, ["Everything in Host", "Your logo and brand colour", "Your own link: meet…/your-name", "Welcome screen, agenda and a question for guests", "Send guests to your page after the call"], upgrade, true)));
      if (user.hasCustomer) b.append(el("div", { className: "row" }, el("button", { onclick: portal }, "Billing details")));
    }
    const proPanel = $("#proPanel");
    proPanel.classList.toggle("locked", !user.pro);
    proPanel.querySelector(".lockmsg").hidden = user.pro;
    proPanel.querySelector(".lockable").inert = !user.pro;
    document.querySelectorAll("[data-upgrade]").forEach((x) => (x.onclick = upgrade));
    for (const id of ["hostTools", "schedule", "apiPanel"]) {
      const p = $("#" + id);
      p.classList.toggle("locked", !user.subscribed);
      p.querySelector(".lockmsg").hidden = user.subscribed;
      p.querySelector(".lockable").inert = !user.subscribed;
    }
    document.querySelectorAll("[data-subscribe]").forEach((x) => (x.onclick = subscribe));
    // Hosts see their meeting tools first; everyone else sees how to become a host first.
    const dash = $("#dash");
    if (user.subscribed) dash.insertBefore($("#billing"), $("#account"));
    else dash.insertBefore($("#billing"), $("#hostTools"));
  }

  async function redirectTo(path, btn, payload) {
    show($("#bmsg"), "", "");
    busy(btn, true);
    const r = await api(path, payload || {});
    if (r.ok && r.data.url) { location.href = r.data.url; return; }
    busy(btn, false);
    show($("#bmsg"), "error", r.data.error || "Something went wrong.");
    $("#billing").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const subscribe = (e) => redirectTo("/api/billing/checkout", e && e.currentTarget, { plan: "host" });
  const upgrade = (e) => redirectTo("/api/billing/checkout", e && e.currentTarget, { plan: "pro" });
  const portal = (e) => redirectTo("/api/billing/portal", e && e.currentTarget);

  $("#personalRotate").onclick = async () => {
    if (!confirm("Get a new personal room link? The current link will stop working for everyone.")) return;
    const r = await api("/api/personal-room/rotate", {});
    if (r.ok) { user.personalRoom = r.data.personalRoom; renderUser(); toast("Your personal room has a new link"); }
    else show($("#imsg"), "error", r.data.error || "Something went wrong.");
  };

  $("#resend").onclick = async (e) => {
    busy(e.currentTarget, true);
    const r = await api("/api/verify/resend", {});
    busy(e.currentTarget, false);
    $("#vmsg").textContent = r.ok ? "Sent. Check your inbox (and spam)." : r.data.error;
  };

  $("#instant").onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true);
    const r = await api("/api/meetings", { instant: true });
    if (r.ok) { location.href = "/m/" + r.data.id; return; }
    busy(btn, false);
    show($("#imsg"), "error", r.data.error);
  };

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dt = new Date(Date.now() + 3600_000);
  const sform = $("#sform");
  sform.date.value = ymd(dt);
  sform.date.min = ymd(new Date());
  sform.time.value = `${pad(dt.getHours())}:00`;

  sform.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    show($("#smsg"), "", "");
    const startsAt = new Date(`${f.date.value}T${f.time.value}`).getTime();
    if (!Number.isFinite(startsAt)) return show($("#smsg"), "error", "Please choose a date and time.");
    if (startsAt < Date.now() - 10 * 60_000) return show($("#smsg"), "error", "That time has already passed. Please pick a time in the future.");
    const btn = $("#sbtn");
    busy(btn, true);
    const r = await api("/api/meetings", { title: f.title.value, startsAt, durationMin: Number(f.duration.value), tz, invitees: f.invitees.value, note: f.note.value });
    busy(btn, false);
    if (!r.ok) return show($("#smsg"), "error", r.data.error || "Something went wrong.");
    f.title.value = f.invitees.value = f.note.value = "";
    toast(r.data.invited ? `Scheduled. ${r.data.invited} invitation${r.data.invited === 1 ? "" : "s"} sent.` : "Scheduled");
    await loadMeetings();
    const li = $("#m-" + r.data.id);
    if (li) li.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function meetingItem(m, past) {
    const li = el("li", { id: "m-" + m.id });
    const now = Date.now();
    const live = !past && now >= m.startsAt - OPEN_BEFORE && now <= m.startsAt + m.durationMin * 60_000;
    const when = past ? fmtDate(m.startsAt) : `${fmtDate(m.startsAt)} · ${live ? "" : relative(m.startsAt) + " · "}${m.durationMin} min`;
    li.append(el("div", { className: "mt" }, el("strong", {}, m.title), live ? el("span", { className: "pill live" }, now < m.startsAt ? "Open now" : "Live") : null, el("span", { className: "muted" }, when)));
    if (m.invited.length) li.append(el("div", { className: "muted small" }, `Invited (${m.invited.length}): ` + m.invited.join(", ")));
    const row = el("div", { className: "row" });
    if (!past) {
      row.append(el("a", { className: "btn" + (live ? " primary" : ""), href: "/m/" + m.id }, live ? "Join now" : "Open"));
      row.append(el("button", { onclick: () => App.copy(m.url).then(() => toast("Meeting link copied")) }, "Copy link"));
      row.append(el("button", { onclick: () => invite(m, li) }, "Invite more"));
    }
    row.append(el("button", { className: "linkbtn", onclick: () => remove(m) }, "Delete"));
    li.append(row);
    return li;
  }

  function invite(m, li) {
    const existing = li.querySelector("form");
    if (existing) { existing.querySelector("textarea").focus(); return; }
    const ta = el("textarea", { rows: 2, placeholder: "Email addresses, separated by commas" });
    ta.setAttribute("aria-label", `Email addresses to invite to ${m.title}`);
    const msg = el("div", { hidden: true });
    const send = el("button", { className: "primary" }, "Send invitations");
    const form = el("form", {}, ta, msg, el("div", { className: "row" }, send, el("button", { type: "button", onclick: () => form.remove() }, "Cancel")));
    form.onsubmit = async (e) => {
      e.preventDefault();
      busy(send, true);
      const r = await api(`/api/meetings/${m.id}/invite`, { invitees: ta.value });
      busy(send, false);
      if (r.ok) { form.remove(); loadMeetings(); toast(r.data.invited ? `${r.data.invited} invitation${r.data.invited === 1 ? "" : "s"} sent` : "Everyone you entered had already been invited"); }
      else show(msg, "error", r.data.error);
    };
    li.append(form);
    ta.focus();
  }

  async function remove(m) {
    if (!confirm(`Delete "${m.title}"? The link will stop working.`)) return;
    const r = await api(`/api/meetings/${m.id}/delete`, {});
    if (r.ok) { loadMeetings(); toast("Meeting deleted"); } else flash("error", r.data.error);
  }

  async function loadMeetings() {
    const r = await api("/api/meetings");
    if (!r.ok) { $("#upcoming").textContent = ""; $("#upcoming").append(el("li", { className: "muted" }, "Couldn't load your meetings. Reload to try again.")); return; }
    const fill = (ul, list, past, empty) => {
      ul.textContent = "";
      if (!list.length) ul.append(el("li", { className: "empty" }, empty));
      list.forEach((m) => ul.append(meetingItem(m, past)));
    };
    fill($("#upcoming"), r.data.upcoming, false, user.subscribed ? "Nothing scheduled. Meetings you schedule appear here." : "Nothing scheduled.");
    fill($("#past"), r.data.past, true, "None yet.");
    $("#pastBox").hidden = !r.data.past.length;
  }

  /* ---------- Pro settings ---------- */
  let pro = null;
  function renderPro() {
    if (!pro) return;
    $("#vprefix").textContent = location.host + "/";
    $("#vcurrent").hidden = !pro.vanity;
    if (pro.vanity) { $("#vlink").href = pro.vanityUrl; $("#vlink").textContent = pro.vanityUrl.replace(/^https?:\/\//, ""); }
    $("#vcopy").onclick = () => App.copy(pro.vanityUrl).then(() => toast("Link copied"));
    $("#logodel").hidden = !pro.logoUrl;
    const bf = $("#bform");
    bf.brandName.value = pro.brandName;
    bf.brandColor.value = pro.brandColor;
    if (pro.brandColor) $("#bcolorpick").value = pro.brandColor;
    const wf = $("#wform");
    wf.welcome.value = pro.welcome;
    ["agenda1", "agenda2", "agenda3"].forEach((n, i) => (wf[n].value = pro.agenda[i] || ""));
    wf.intakeQuestion.value = pro.intakeQuestion;
    wf.redirectUrl.value = pro.redirectUrl;
    $("#wpreview").href = pro.vanityUrl || "/m/" + user.personalRoom;
    previewBrand();
  }
  function previewBrand() {
    const color = /^#[0-9a-f]{6}$/i.test($("#bform").brandColor.value) ? $("#bform").brandColor.value : "";
    $("#bpreview").style.setProperty("--bp", color || "var(--accent)");
    $("#bplogo").hidden = !(pro && pro.logoUrl);
    if (pro && pro.logoUrl) $("#bplogo").src = pro.logoUrl;
    $("#bpname").hidden = !!(pro && pro.logoUrl);
    $("#bpname").textContent = $("#bform").brandName.value || "Your company";
  }
  async function loadPro() {
    const r = await api("/api/pro/settings");
    if (r.ok) { pro = r.data.settings; renderPro(); }
  }
  $("#bcolorpick").oninput = () => { $("#bform").brandColor.value = $("#bcolorpick").value; previewBrand(); };
  $("#bform").brandColor.oninput = () => { if (/^#[0-9a-f]{6}$/i.test($("#bform").brandColor.value)) $("#bcolorpick").value = $("#bform").brandColor.value; previewBrand(); };
  $("#bform").brandName.oninput = previewBrand;
  $("#bform").onsubmit = (e) => e.preventDefault();

  $("#logofile").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast("Please choose a PNG, JPEG or WebP image");
    if (f.size > 200 * 1024) return toast("That image is over 200 KB. Please use a smaller one");
    const res = await fetch("/api/pro/logo", { method: "POST", headers: { "Content-Type": f.type }, body: f, credentials: "same-origin" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return toast(d.error || "Couldn't upload the logo");
    pro = d.settings; renderPro(); toast("Logo uploaded");
  };
  $("#logodel").onclick = async () => {
    const r = await api("/api/pro/logo/delete", {});
    if (r.ok) { pro = r.data.settings; renderPro(); toast("Logo removed"); }
  };

  let vTimer = 0;
  $("#vform").name.oninput = (e) => {
    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (v !== e.target.value) e.target.value = v;
    clearTimeout(vTimer);
    $("#vstate").textContent = "";
    if (v.length < 3) return;
    vTimer = setTimeout(async () => {
      const r = await api("/api/pro/vanity/check?name=" + encodeURIComponent(v));
      if (r.ok && $("#vform").name.value === v) $("#vstate").textContent = r.data.available ? `✓ ${location.host}/${v} is available` : r.data.reason;
    }, 300);
  };
  $("#vform").onsubmit = async (e) => {
    e.preventDefault();
    busy($("#vbtn"), true);
    const r = await api("/api/pro/vanity", { name: e.target.name.value });
    busy($("#vbtn"), false);
    if (!r.ok) { $("#vstate").textContent = r.data.error; return; }
    e.target.name.value = "";
    $("#vstate").textContent = "";
    pro = r.data.settings; renderPro(); toast("Your link is ready");
  };
  $("#vrelease").onclick = async () => {
    if (!confirm("Release your link? Anyone could claim it after you.")) return;
    const r = await api("/api/pro/vanity", { name: "" });
    if (r.ok) { pro = r.data.settings; renderPro(); toast("Link released"); }
  };

  $("#wform").onsubmit = async (e) => {
    e.preventDefault();
    const wf = e.target, bf = $("#bform");
    show($("#wmsg"), "", "");
    busy($("#wbtn"), true);
    const r = await api("/api/pro/settings", {
      brandName: bf.brandName.value, brandColor: bf.brandColor.value.trim(),
      welcome: wf.welcome.value, agenda: [wf.agenda1.value, wf.agenda2.value, wf.agenda3.value], intakeQuestion: wf.intakeQuestion.value, redirectUrl: wf.redirectUrl.value.trim(),
    });
    busy($("#wbtn"), false);
    if (!r.ok) return show($("#wmsg"), "error", r.data.error || "Something went wrong.");
    pro = r.data.settings; renderPro(); toast("Pro settings saved");
  };

  /* ---------- API keys ---------- */
  async function loadKeys() {
    const r = await api("/api/keys");
    const ul = $("#keys");
    ul.textContent = "";
    if (!r.ok) return;
    if (!r.data.keys.length) ul.append(el("li", { className: "muted small" }, "No API keys yet."));
    for (const k of r.data.keys) {
      const used = k.lastUsedAt ? `last used ${fmtDate(k.lastUsedAt)}` : "never used";
      ul.append(el("li", {},
        el("div", { className: "mt" }, el("strong", {}, k.name), el("span", { className: "muted small" }, `${k.prefix}… · made ${fmtDay(k.createdAt)} · ${used}`)),
        el("div", { className: "row" }, el("button", { className: "linkbtn", onclick: () => deleteKey(k) }, "Delete"))));
    }
  }
  async function deleteKey(k) {
    if (!confirm(`Delete the key "${k.name}"? Anything using it will stop working straight away.`)) return;
    const r = await api(`/api/keys/${k.id}/delete`, {});
    if (r.ok) { toast("Key deleted"); loadKeys(); } else show($("#kmsg"), "error", r.data.error);
  }
  async function loadOrigins(list) {
    const origins = list || ((await api("/api/embed-origins")).data.origins || []);
    const ul = $("#origins");
    ul.textContent = "";
    if (!origins.length) ul.append(el("li", { className: "muted small" }, "None yet: meetings only open on this site."));
    for (const o of origins) {
      ul.append(el("li", {}, el("div", { className: "mt" }, el("strong", {}, o)),
        el("div", { className: "row" }, el("button", { className: "linkbtn", onclick: () => removeOrigin(o) }, "Remove"))));
    }
  }
  async function removeOrigin(o) {
    if (!confirm(`Stop ${o} from showing your meetings? Meetings already open there will stop loading.`)) return;
    const r = await api("/api/embed-origins/delete", { origin: o });
    if (r.ok) { toast("Removed"); loadOrigins(r.data.origins); } else show($("#omsg"), "error", r.data.error);
  }
  $("#oform").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("#omsg"), "", "");
    busy($("#obtn"), true);
    const r = await api("/api/embed-origins", { origin: e.target.origin.value.trim() });
    busy($("#obtn"), false);
    if (!r.ok) return show($("#omsg"), "error", r.data.error || "Something went wrong.");
    e.target.origin.value = "";
    toast("Allowed");
    loadOrigins(r.data.origins);
  });

  $("#kform").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("#kmsg"), "", "");
    busy($("#kbtn"), true);
    const r = await api("/api/keys", { name: e.target.name.value });
    busy($("#kbtn"), false);
    if (!r.ok) return show($("#kmsg"), "error", r.data.error || "Something went wrong.");
    e.target.name.value = "";
    $("#newKey").hidden = false;
    $("#newKeyValue").value = r.data.key;
    $("#newKeyCopy").onclick = () => App.copy(r.data.key).then(() => toast("API key copied"));
    $("#newKeyValue").select();
    loadKeys();
  });

  $("#dform").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!e.target.password.value) return show($("#dmsg"), "error", "Please enter your password.");
    if (!confirm("Really delete your account? This can't be undone.")) return;
    const btn = e.target.querySelector("button.danger");
    busy(btn, true);
    const r = await api("/api/account/delete", { password: e.target.password.value });
    if (r.ok) { location.href = "/"; return; }
    busy(btn, false);
    show($("#dmsg"), "error", r.data.error);
  });

  async function init() {
    const d = await App.me();
    document.querySelectorAll("[data-app]").forEach((x) => (x.textContent = d.appName));
    if (!d.user) { location.replace("/login?next=/dashboard"); return; }
    user = d.user;
    const q = new URLSearchParams(location.search);
    if (q.get("checkout") === "success" && q.get("session_id")) {
      flash("ok", "Thanks! Confirming your payment…");
      const r = await api("/api/billing/confirm", { sessionId: q.get("session_id") });
      if (r.ok && r.data.user) { user = r.data.user; flash(user.subscribed ? "ok" : "error", user.subscribed ? "You're a host. You can now start and schedule meetings." : "Your payment is still being confirmed. Reload in a minute."); }
      else flash("error", r.data.error || "We couldn't confirm the payment yet. Reload in a minute.");
      history.replaceState(null, "", "/dashboard");
    } else if ((q.get("checkout") || "").startsWith("cancel")) {
      flash("error", "Checkout was cancelled. You haven't been charged.");
      history.replaceState(null, "", "/dashboard");
    }
    renderUser();
    loadMeetings();
    loadKeys();
    loadOrigins();
    loadPro();
    // Keep "in 5 minutes" / "Live" up to date if the page stays open.
    setInterval(() => { if (!document.querySelector(".meetings form")) loadMeetings(); }, 60_000);
  }
  init();
})();
