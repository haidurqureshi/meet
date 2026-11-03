(function () {
  const { $, api, show } = App;
  let user = null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  $("#tz").textContent = tz;

  const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); e.append(...kids.filter((k) => k != null)); return e; };
  const fmtDate = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  $("#logout").onclick = App.logout;

  function flash(kind, text) { show($("#flash"), kind, text); window.scrollTo({ top: 0, behavior: "smooth" }); }

  function renderUser() {
    $("#who").textContent = user.name;
    $("#verifyBox").hidden = user.verified;
    $("#vemail").textContent = user.email;
    const url = location.origin + "/m/" + user.personalRoom;
    $("#personalUrl").value = url;
    $("#personalGo").href = "/m/" + user.personalRoom;
    $("#personalCopy").onclick = (e) => App.copy(url, e.target);

    const b = $("#billingBody");
    b.textContent = "";
    if (user.subscribed) {
      const end = user.periodEnd ? fmtDay(user.periodEnd) : null;
      b.append(el("p", {}, el("strong", {}, "Active"), ` – ${user.price}.`, end ? (user.cancelAtEnd ? ` Ends on ${end} (won't renew).` : ` Renews on ${end}.`) : ""));
      if (user.hasCustomer) b.append(el("div", { className: "row" }, el("button", { onclick: portal }, "Manage billing / cancel")));
    } else {
      const was = user.subStatus && user.subStatus !== "none";
      b.append(el("p", {}, was ? "Your host subscription isn't active. " : "", `Hosting meetings costs ${user.price}. Cancel any time. Guests joining your meetings don't pay.`));
      const row = el("div", { className: "row" }, el("button", { className: "primary", onclick: subscribe }, `Become a host – ${user.price}`));
      if (user.hasCustomer) row.append(el("button", { onclick: portal }, "Billing details"));
      b.append(row);
    }
    document.querySelectorAll("#hostTools button.primary, #schedule button.primary").forEach((x) => (x.title = user.subscribed ? "" : "Needs a host account"));
    $("#hostTools").classList.toggle("locked", !user.subscribed);
    $("#schedule").classList.toggle("locked", !user.subscribed);
  }

  async function redirectTo(path, bodyObj) {
    show($("#bmsg"), "", "");
    const r = await api(path, bodyObj || {});
    if (r.ok && r.data.url) { location.href = r.data.url; return; }
    show($("#bmsg"), "error", r.data.error || "Something went wrong.");
  }
  const subscribe = () => redirectTo("/api/billing/checkout");
  const portal = () => redirectTo("/api/billing/portal");

  $("#resend").onclick = async () => {
    const r = await api("/api/verify/resend", {});
    $("#vmsg").textContent = r.ok ? "Sent. Check your inbox (and spam)." : r.data.error;
  };

  $("#instant").onclick = async (e) => {
    e.target.disabled = true;
    const r = await api("/api/meetings", { instant: true });
    e.target.disabled = false;
    if (r.ok) location.href = "/m/" + r.data.id;
    else show($("#imsg"), "error", r.data.error);
  };

  const dt = new Date(Date.now() + 3600_000);
  const pad = (n) => String(n).padStart(2, "0");
  $("#sform").date.value = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  $("#sform").time.value = `${pad(dt.getHours())}:00`;

  $("#sform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    show($("#smsg"), "", "");
    const startsAt = new Date(`${f.date.value}T${f.time.value}`).getTime();
    if (!Number.isFinite(startsAt)) return show($("#smsg"), "error", "Please choose a date and time.");
    const btn = f.querySelector("button");
    btn.disabled = true;
    const r = await api("/api/meetings", { title: f.title.value, startsAt, durationMin: Number(f.duration.value), tz, invitees: f.invitees.value, note: f.note.value });
    btn.disabled = false;
    if (!r.ok) return show($("#smsg"), "error", r.data.error || "Something went wrong.");
    f.title.value = f.invitees.value = f.note.value = "";
    show($("#smsg"), "ok", r.data.invited ? `Scheduled. ${r.data.invited} invitation${r.data.invited === 1 ? "" : "s"} sent.` : "Scheduled. Copy the link from the list below to share it.");
    loadMeetings();
  });

  function meetingItem(m, past) {
    const li = el("li", {});
    li.append(el("div", { className: "mt" }, el("strong", {}, m.title), el("span", { className: "muted" }, ` ${fmtDate(m.startsAt)} · ${m.durationMin} min`)));
    if (m.invited.length) li.append(el("div", { className: "muted small" }, "Invited: " + m.invited.join(", ")));
    const row = el("div", { className: "row" });
    if (!past) {
      row.append(el("a", { className: "btn primary", href: "/m/" + m.id }, "Start / open"));
      row.append(el("button", { onclick: (e) => App.copy(m.url, e.target) }, "Copy link"));
      row.append(el("button", { onclick: () => invite(m, li) }, "Invite more"));
    }
    row.append(el("button", { className: "danger", onclick: () => remove(m) }, "Delete"));
    li.append(row);
    return li;
  }

  function invite(m, li) {
    if (li.querySelector("form")) return;
    const ta = el("textarea", { rows: 2, placeholder: "Email addresses" });
    const msg = el("div", { hidden: true });
    const form = el("form", {}, ta, msg, el("div", { className: "row" }, el("button", { className: "primary" }, "Send"), el("button", { type: "button", onclick: () => form.remove() }, "Cancel")));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const r = await api(`/api/meetings/${m.id}/invite`, { invitees: ta.value });
      if (r.ok) { form.remove(); loadMeetings(); flash("ok", r.data.invited ? `${r.data.invited} invitation${r.data.invited === 1 ? "" : "s"} sent.` : "Everyone you entered had already been invited."); }
      else show(msg, "error", r.data.error);
    };
    li.append(form);
  }

  async function remove(m) {
    if (!confirm(`Delete "${m.title}"? The link will stop working.`)) return;
    const r = await api(`/api/meetings/${m.id}/delete`, {});
    if (r.ok) loadMeetings(); else flash("error", r.data.error);
  }

  async function loadMeetings() {
    const r = await api("/api/meetings");
    if (!r.ok) return;
    const fill = (ul, list, past, empty) => {
      ul.textContent = "";
      if (!list.length) ul.append(el("li", { className: "muted" }, empty));
      list.forEach((m) => ul.append(meetingItem(m, past)));
    };
    fill($("#upcoming"), r.data.upcoming, false, "Nothing scheduled.");
    fill($("#past"), r.data.past, true, "None yet.");
  }

  $("#dform").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!confirm("Really delete your account? This can't be undone.")) return;
    const r = await api("/api/account/delete", { password: e.target.password.value });
    if (r.ok) location.href = "/"; else show($("#dmsg"), "error", r.data.error);
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
  }
  init();
})();
