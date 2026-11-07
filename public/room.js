// Meeting room: up to 4 people, every pair connected directly (through Cloudflare TURN relays).
(function () {
  const { $, api, show, toast } = App;
  const vanityMeta = document.querySelector('meta[name="meet-room"]');
  const code = (/^\/m\/([a-z2-9]{12})$/.exec(location.pathname) || [])[1] || (vanityMeta && /^[a-z2-9]{12}$/.test(vanityMeta.content) ? vanityMeta.content : undefined);
  const keyName = "meet-key-" + code;
  let info = null, join = null, ws = null, localStream = null, screenStream = null;
  let micOn = true, camOn = true, sharing = false, left = false, failures = 0, retryTimer = null, unread = 0;
  const peers = new Map();
  // Up to 4 people connect directly ("mesh"). When a 5th joins, the room switches everyone to Cloudflare RealtimeKit,
  // where Cloudflare's servers forward the video. The room's server tells us when ("upgrade"); our connection to it
  // stays open for chat and the people count.
  let rtk = null, rtkDevices = { mic: false, cam: false }, upgrading = null;
  const names = new Map(); // who is here, from the room server (used for join/leave messages)
  // What each person may do, set by the host and sent by the room server ("roster").
  const ALL = { mic: true, cam: true, share: true, chat: true };
  let roster = { defaults: { ...ALL }, people: [] }, myAllow = { ...ALL }, rosterSeen = false;
  const amHost = () => !!(join && join.isHost);
  // "speaker": the others fill the screen and your own camera floats small in a corner (like Zoom).
  // "gallery": everyone the same size. The choice and the corner are remembered.
  let view = "speaker", pipCorner = "br";
  try { view = localStorage.getItem("meet-view") === "gallery" ? "gallery" : "speaker"; pipCorner = localStorage.getItem("meet-pip") || "br"; } catch { /* ignore */ }
  if (!["tl", "tr", "bl", "br"].includes(pipCorner)) pipCorner = "br";
  // A secret per meeting tab: the server turns it into our id in the room, so a reload keeps our place
  // but nobody else can take it. Only our id (never this key) is shown to the others.
  let pid = "", key = "";
  // A personal join link (?link=..., made by another site through the API) says who you are and whether you host.
  // Take it out of the address bar straight away so it isn't shared by accident; keep it for this tab.
  let joinLink = "";
  try {
    const q = new URLSearchParams(location.search);
    joinLink = q.get("link") || sessionStorage.getItem("meet-link-" + code) || "";
    if (q.has("link")) {
      if (joinLink) sessionStorage.setItem("meet-link-" + code, joinLink);
      history.replaceState(null, "", location.pathname);
    }
  } catch { /* storage blocked: the link still works for this page load */ }
  try { key = sessionStorage.getItem(keyName) || ""; } catch { /* storage blocked */ }

  // Shown inside another website's page (an iframe made with the API)? Then hide this site's own links and tell
  // that page what's happening: {source:"meet", event, meeting, ...}. Only sent to the sites the host allowed.
  let embedded = false;
  try { embedded = window.self !== window.top; } catch { embedded = true; }
  if (embedded) document.body.classList.add("embedded");
  let lastCount = 0;
  function tellParent(event, extra) {
    if (!embedded || !info || !Array.isArray(info.embedOrigins)) return;
    const msg = { source: "meet", event, meeting: code, ...(extra || {}) };
    for (const o of info.embedOrigins) { try { window.parent.postMessage(msg, o); } catch { /* ignore */ } }
  }

  const panel = (id) => {
    ["loading", "notice", "lobby", "room"].forEach((p) => ($("#" + p).hidden = p !== id));
    document.body.classList.toggle("in-call", id === "room");
  };
  function notice(title, text, retry) {
    panel("notice");
    $("#ntitle").textContent = title;
    $("#ntext").textContent = text;
    $("#nretry").hidden = !retry;
    $("#ngo").hidden = true;
    document.title = title;
  }
  const initials = (name) => (String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"); };

  /* ---------- lobby ---------- */
  async function start() {
    if (!code) return notice("No meeting here", "Open the full meeting link you were sent, or go home and paste it.");
    const r = await api("/api/room/" + code + (joinLink ? "?link=" + encodeURIComponent(joinLink) : ""));
    if (!r.ok) return notice("Meeting not found", r.data.error || "Check you copied the whole link.");
    info = r.data;
    document.title = info.title;
    applyBrand(info.brand);
    if (info.status !== "open") tellParent("not_open", { status: info.status, startsAt: info.startsAt });
    if (info.status === "unavailable") return notice("Not available", "This meeting can't be started right now. Ask the host to check their account.");
    if (info.status === "over") return notice("Meeting finished", "This meeting has ended. Ask the host for a new link.");
    if (info.status === "early") {
      const when = info.startsAt ? new Date(info.startsAt).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
      return notice("Not open yet", `"${info.title}" starts ${when}. The room opens 15 minutes before. Come back then.`);
    }
    panel("lobby");
    tellParent("ready", { title: info.title, isHost: !!info.isHost });
    $("#ltitle").textContent = info.title;
    $("#lhost").textContent = info.isHost ? "You're the host" : `Hosted by ${info.hostName}`;
    if (info.maxPeople) $("#lmax").textContent = `Up to ${info.maxPeople} people. Nothing is recorded.`;
    let saved = "";
    try { saved = localStorage.getItem("meet-name") || ""; } catch { /* ignore */ }
    $("#lname").value = info.userName || saved;
    $("#lname").readOnly = !!info.nameFixed;
    $("#lname").title = info.nameFixed ? "Set by your invitation link" : "";
    showWelcome(info.waiting);
    getMedia().then(() => { if (!$("#lname").value) $("#lname").focus(); else $("#ljoin").focus(); });
  }

  /* ---------- Pro: the host's branding and waiting room ---------- */
  function applyBrand(b) {
    if (!b || (!b.logoUrl && !b.name && !b.color)) return;
    document.body.classList.add("branded"); // hides this site's own links
    if (b.color && /^#[0-9a-f]{6}$/i.test(b.color)) {
      const n = parseInt(b.color.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, bl = n & 255;
      const light = (0.299 * r + 0.587 * g + 0.114 * bl) / 255 > 0.6;
      const root = document.documentElement.style;
      root.setProperty("--accent", b.color);
      root.setProperty("--accent-hover", `color-mix(in srgb, ${b.color} 82%, ${light ? "black" : "white"})`);
      root.setProperty("--accent-ink", light ? "#111111" : "#ffffff");
      root.setProperty("--focus", b.color);
    }
    for (const [box, img, label] of [["#lbrand", "#llogo", "#lbrandname"], ["#nbrand", "#nlogo", "#nbrandname"]]) {
      $(box).hidden = false;
      $(img).hidden = !b.logoUrl;
      if (b.logoUrl) { $(img).src = b.logoUrl; $(img).alt = b.name || ""; }
      $(label).textContent = b.logoUrl ? "" : b.name || "";
    }
    if (b.logoUrl) {
      $("#rlogo").src = b.logoUrl; $("#rlogo").alt = b.name || ""; $("#rlogo").hidden = false;
      const icon = document.querySelector('link[rel="icon"]');
      if (icon) { icon.href = b.logoUrl; icon.removeAttribute("type"); }
    }
  }

  let pendingIntake = "";
  function showWelcome(w) {
    if (!w || (!w.welcome && !(w.agenda || []).length && !w.intakeQuestion)) return;
    $("#lwelcome").hidden = !w.welcome && !(w.agenda || []).length;
    $("#lwelcometext").textContent = w.welcome || "";
    $("#lwelcometext").hidden = !w.welcome;
    $("#lagendawrap").hidden = !(w.agenda || []).length;
    $("#lagenda").textContent = "";
    for (const item of w.agenda || []) $("#lagenda").append(Object.assign(document.createElement("li"), { textContent: item }));
    // The host's question: guests answer it before joining. Hosts don't see it here.
    $("#lintakewrap").hidden = !w.intakeQuestion || !!info.isHost;
    $("#lintakeq").textContent = w.intakeQuestion || "";
  }

  /* ---------- pre-call check: camera, microphone and speakers ---------- */
  const VIDEO = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } };
  const AUDIO = { echoCancellation: true, noiseSuppression: true };
  let camErr = null, micErr = null, heardMic = false, meterRaf = 0, meterCtx = null;
  const savedDevice = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };

  async function getMedia(chosen) {
    if (localStream && !chosen) return;
    const camId = (chosen && chosen.cam) || savedDevice("meet-cam");
    const micId = (chosen && chosen.mic) || savedDevice("meet-mic");
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null; camErr = micErr = null; heardMic = false;
    setCheck("checking");
    const video = { ...VIDEO, ...(camId ? { deviceId: chosen && chosen.cam ? { exact: camId } : { ideal: camId } } : {}) };
    const audio = { ...AUDIO, ...(micId ? { deviceId: chosen && chosen.mic ? { exact: micId } : { ideal: micId } } : {}) };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camErr = micErr = { name: "Insecure" };
      localStream = new MediaStream();
    } else {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      } catch (both) {
        // Find out which one is the problem, and keep whichever works.
        let a = null, v = null;
        try { a = await navigator.mediaDevices.getUserMedia({ audio }); } catch (e) { micErr = e; }
        try { v = await navigator.mediaDevices.getUserMedia({ video }); } catch (e) { camErr = e; }
        localStream = new MediaStream([...(a ? a.getTracks() : []), ...(v ? v.getTracks() : [])]);
      }
    }
    // Some browsers report a block with a vague error: their permission status says what really happened.
    for (const [kind, set] of [["camera", (e) => (camErr = e)], ["microphone", (e) => (micErr = e)]]) {
      const err = kind === "camera" ? camErr : micErr;
      if (!err || blocked(err)) continue;
      try { if ((await navigator.permissions.query({ name: kind })).state === "denied") set({ name: "NotAllowedError" }); } catch { /* not supported */ }
    }
    if (!localStream.getVideoTracks().length && !camErr) camErr = { name: "NotFoundError" };
    if (!localStream.getAudioTracks().length && !micErr) micErr = { name: "NotFoundError" };
    $("#lpreview").srcObject = localStream;
    $("#lnocam").hidden = !!localStream.getVideoTracks().length;
    $("#lnocam").textContent = camErr ? "Your camera isn't on. See below." : "";
    await fillDevices();
    startMeter();
    setCheck();
    syncButtons();
  }

  async function fillDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    for (const [sel, kind, track] of [["#selcam", "videoinput", videoTrack()], ["#selmic", "audioinput", audioTrack()]]) {
      const devs = list.filter((d) => d.kind === kind && d.deviceId);
      const el = $(sel);
      el.textContent = "";
      devs.forEach((d, i) => el.append(Object.assign(document.createElement("option"), { value: d.deviceId, textContent: d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}` })));
      const current = track && track.getSettings ? track.getSettings().deviceId : "";
      if (current) el.value = current;
      el.hidden = devs.length < 2 || !track;
    }
  }
  $("#selcam").onchange = () => { try { localStorage.setItem("meet-cam", $("#selcam").value); } catch { /* ignore */ } getMedia({ cam: $("#selcam").value }); };
  $("#selmic").onchange = () => { try { localStorage.setItem("meet-mic", $("#selmic").value); } catch { /* ignore */ } getMedia({ mic: $("#selmic").value }); };
  $("#lretry").onclick = () => getMedia({});

  /** Live microphone level, so people can see they're being heard. */
  function startMeter() {
    cancelAnimationFrame(meterRaf);
    const track = audioTrack();
    if (!track || !window.AudioContext) return;
    try {
      meterCtx = meterCtx || new AudioContext();
      const an = meterCtx.createAnalyser();
      an.fftSize = 512;
      meterCtx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if ($("#lobby").hidden) return;
        if (meterCtx.state === "suspended") meterCtx.resume().catch(() => {});
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
        $("#micbar").style.width = Math.min(100, peak * 1.6) + "%";
        if (peak > 10 && micOn && !heardMic) { heardMic = true; setCheck(); }
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* no meter: the check still works */ }
  }

  $("#spktest").onclick = () => {
    try {
      meterCtx = meterCtx || new AudioContext();
      meterCtx.resume();
      const o = meterCtx.createOscillator(), g = meterCtx.createGain(), t = meterCtx.currentTime;
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(meterCtx.destination);
      o.start(t); o.stop(t + 0.75);
      setRow("#ckspk", "ok", "Did you hear a beep? If not, check your volume or headphones.");
    } catch { setRow("#ckspk", "warn", "Your browser couldn't play a sound."); }
  };

  function setRow(id, state, text) {
    const li = $(id);
    li.className = "ck s-" + state;
    li.querySelector(".ckstate").textContent = text;
  }

  const blocked = (e) => e && (e.name === "NotAllowedError" || e.name === "SecurityError" || e.name === "PermissionDeniedError");
  const busy = (e) => e && (e.name === "NotReadableError" || e.name === "TrackStartError" || e.name === "AbortError");
  function errText(e, what) {
    if (!e) return "";
    if (blocked(e)) return `Blocked by your browser`;
    if (busy(e)) return `Being used by another app`;
    if (e.name === "Insecure") return "Needs a secure (https) connection";
    return `No ${what} found`;
  }

  /** The browser-specific way to unblock the camera and microphone. */
  function unblockGuide() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios) return { side: "left", steps: ["Tap <b>aA</b> on the left of the address bar, then <b>Website Settings</b>.", "Set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>.", "Tap <b>Try again</b> below."] };
    if (/Android/.test(ua)) return { side: "left", steps: ["Tap the icon on the left of the address bar, then <b>Permissions</b>.", "Turn on <b>Camera</b> and <b>Microphone</b>.", "Tap <b>Try again</b> below."] };
    if (/Firefox\//.test(ua)) return { side: "left", steps: ["Click the crossed-out camera icon on the <b>left</b> of the address bar.", "Click the <b>✕</b> next to <b>Blocked</b> for the camera and microphone.", "Click <b>Try again</b> below and choose <b>Allow</b>."] };
    if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return { side: "left", steps: ["In the menu bar, choose <b>Safari › Settings for This Website…</b>", "Set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>.", "Click <b>Try again</b> below."] };
    return { side: "right", steps: ["Click the camera icon with a red cross on the <b>right</b> of the address bar.", "Choose <b>Always allow</b>, then <b>Done</b>.", "Click <b>Try again</b> below."] };
  }

  function setCheck(phase) {
    const ready = $("#lready");
    if (phase === "checking") {
      ready.className = "lready s-checking";
      $("#lreadytitle").textContent = "Checking your camera and microphone…";
      $("#lreadytext").textContent = "";
      setRow("#ckcam", "checking", "Checking…");
      setRow("#ckmic", "checking", "Checking…");
      $("#lfix").hidden = true;
      return;
    }
    setRow("#ckcam", camErr ? "bad" : "ok", camErr ? errText(camErr, "camera") : "Working");
    setRow("#ckmic", micErr ? "bad" : heardMic ? "ok" : "ok", micErr ? errText(micErr, "microphone") : heardMic ? "Working: we can hear you" : "Working: say something to test it");
    const fix = $("#lfix");
    const anyBlocked = blocked(camErr) || blocked(micErr), anyBusy = busy(camErr) || busy(micErr);
    if (!camErr && !micErr) {
      ready.className = "lready s-ok";
      $("#lreadytitle").textContent = "You're all set";
      $("#lreadytext").textContent = "Your camera and microphone are working.";
    } else if (!micErr) {
      ready.className = "lready s-warn";
      $("#lreadytitle").textContent = "Ready, with sound only";
      $("#lreadytext").textContent = "Others will hear you but won't see you.";
    } else {
      ready.className = "lready s-bad";
      $("#lreadytitle").textContent = "We can't use your microphone";
      $("#lreadytext").textContent = "Others won't hear you. You can still join, watch and chat.";
    }
    fix.hidden = !(anyBlocked || anyBusy || (camErr && camErr.name === "Insecure"));
    if (fix.hidden) return;
    const what = (blocked(camErr) || busy(camErr)) && (blocked(micErr) || busy(micErr)) ? "camera and microphone" : blocked(camErr) || busy(camErr) ? "camera" : "microphone";
    let steps, side = "none";
    if (anyBlocked) {
      $("#lfixtitle").textContent = `Your browser is blocking the ${what}`;
      const g = unblockGuide();
      steps = g.steps; side = g.side;
    } else if (anyBusy) {
      $("#lfixtitle").textContent = `Your ${what} is being used by another app`;
      steps = ["Close other apps that might be using it (Zoom, Teams, FaceTime, Skype) or other browser tabs with a call.", "Click <b>Try again</b> below."];
    } else {
      $("#lfixtitle").textContent = "This page needs a secure connection";
      steps = ["Open the meeting link starting with <b>https://</b>."];
    }
    $("#lfixvisual").setAttribute("class", "fixvisual side-" + side);
    $("#lfixhost").textContent = location.host;
    $("#lfixsteps").innerHTML = steps.map((t) => `<li>${t}</li>`).join(""); // fixed text above, nothing from users
  }

  const audioTrack = () => localStream && localStream.getAudioTracks()[0];
  const videoTrack = () => localStream && localStream.getVideoTracks()[0];
  const hasMic = () => (rtk ? rtkDevices.mic : !!audioTrack());
  const hasCam = () => (rtk ? rtkDevices.cam : !!videoTrack());

  function syncButtons() {
    const a = hasMic(), v = hasCam();
    for (const [id, on, onText, offText, has] of [["lmic", micOn, "Mute", "Unmute", a], ["cmic", micOn, "Mute", "Unmute", a], ["lcam", camOn, "Stop video", "Start video", v], ["ccam", camOn, "Stop video", "Start video", v]]) {
      const b = $("#" + id);
      const ok = id.endsWith("mic") ? myAllow.mic : myAllow.cam;
      b.disabled = !has || (!ok && !on);
      b.classList.toggle("locked", has && !ok);
      b.title = has && !ok ? "The host has turned this off for you" : id.endsWith("mic") ? "Microphone (M)" : "Camera (V)";
      b.setAttribute("aria-pressed", String(!on || !has));
      b.querySelector(".lbl").textContent = !has ? (id.endsWith("mic") ? "No mic" : "No camera") : on ? onText : offText;
    }
    if (!rtk) {
      const at = audioTrack(), vt = videoTrack();
      if (at) at.enabled = micOn;
      if (vt) vt.enabled = camOn;
    }
    const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $("#cshare").hidden = !canShare; // phones can't share their screen
    $("#cshare").querySelector(".lbl").textContent = sharing ? "Stop share" : "Share";
    $("#cshare").setAttribute("aria-pressed", String(sharing));
    $("#cshare").disabled = !myAllow.share && !sharing;
    $("#cshare").classList.toggle("locked", !myAllow.share);
    $("#cshare").title = myAllow.share ? "Share your screen" : "The host has turned off screen sharing for you";
    const self = $("#tile-self");
    if (self) {
      self.querySelector("video").classList.toggle("mirror", !sharing);
      setTileState(self, { mic: micOn && !!a, cam: (camOn && !!v) || sharing, share: sharing });
    }
    if ($("#lpreview")) $("#lpreview").hidden = !(camOn && v);
  }
  function broadcastState() {
    const state = { mic: micOn && !!audioTrack(), cam: (camOn && !!videoTrack()) || sharing, share: sharing };
    for (const id of peers.keys()) send({ type: "signal", to: id, data: { state } });
  }
  async function rtkSet(kind, on) {
    try {
      if (kind === "mic") await (on ? rtk.self.enableAudio() : rtk.self.disableAudio());
      else await (on ? rtk.self.enableVideo() : rtk.self.disableVideo());
    } catch (err) { console.warn("RealtimeKit", kind, err); }
    micOn = !!rtk.self.audioEnabled; camOn = !!rtk.self.videoEnabled;
    syncButtons();
  }
  const toggleMic = () => { if (!micOn && !myAllow.mic) return toast("The host has turned off your microphone"); micOn = !micOn; if (rtk) return rtkSet("mic", micOn); syncButtons(); broadcastState(); };
  const toggleCam = () => { if (!camOn && !myAllow.cam) return toast("The host has turned off your camera"); camOn = !camOn; if (rtk) return rtkSet("cam", camOn); syncButtons(); broadcastState(); };
  $("#lmic").onclick = $("#cmic").onclick = toggleMic;
  $("#lcam").onclick = $("#ccam").onclick = toggleCam;

  $("#lform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#lname").value.trim();
    if (!name) { $("#lname").focus(); return show($("#lmsg"), "error", "Please type your name."); }
    App.busy($("#ljoin"), true);
    show($("#lmsg"), "", "");
    if (!info.nameFixed) try { localStorage.setItem("meet-name", name); } catch { /* ignore */ }
    pendingIntake = $("#lintakewrap").hidden ? "" : $("#lintake").value.trim().slice(0, 500);
    const ok = await fetchJoin(name);
    App.busy($("#ljoin"), false);
    if (ok) enterRoom(name);
  });

  async function fetchJoin(name) {
    const r = await api("/api/join", { room: code, name, key, link: joinLink || undefined });
    if (!r.ok) { show($("#lmsg"), "error", r.data.error || "Couldn't join."); if (r.status === 410 || r.status === 403) notice("Can't join", r.data.error); return false; }
    join = r.data;
    pid = join.pid;
    key = join.key;
    try { sessionStorage.setItem(keyName, key); } catch { /* ignore */ }
    join.name = name;
    return true;
  }

  /* ---------- room UI ---------- */
  const meetingLink = () => location.origin + (vanityMeta ? location.pathname.replace(/\/$/, "") : "/m/" + code);
  function enterRoom(name) {
    panel("room");
    tellParent("joined", { name, isHost: !!join.isHost });
    if (embedded) $("#wait p").textContent = "Waiting for the others to join…";
    $("#rtitle").textContent = info.title;
    $("#wurl").value = meetingLink();
    $("#wcopy").onclick = $("#rcopy").onclick = () => App.copy(meetingLink()).then(() => toast("Meeting link copied"));
    addTile("self", name, localStream, true);
    syncButtons();
    left = false;
    connect();
    layout();
  }

  function addTile(id, name, stream, isSelf) {
    let t = $("#tile-" + id);
    if (!t) {
      t = document.createElement("div");
      t.className = "tile";
      t.id = "tile-" + id;
      t.tabIndex = 0;
      t.setAttribute("role", "button");
      t.title = "Click to enlarge";
      const v = document.createElement("video");
      v.autoplay = true; v.playsInline = true;
      if (isSelf) { v.muted = true; v.classList.add("mirror"); }
      const av = document.createElement("div");
      av.className = "avatar"; av.hidden = true;
      av.append(document.createElement("span"));
      const cap = document.createElement("span");
      cap.className = "cap";
      const muted = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      muted.setAttribute("class", "icon muted-icon");
      muted.setAttribute("aria-label", "muted");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#i-mic-off");
      muted.append(use);
      muted.style.display = "none";
      const nm = document.createElement("span");
      nm.className = "name";
      cap.append(muted, nm);
      const ov = document.createElement("span");
      ov.className = "ov"; ov.textContent = "Connecting…";
      t.append(v, av, cap, ov);
      const spot = () => {
        const on = !t.classList.contains("spot");
        document.querySelectorAll(".tile.spot").forEach((x) => x.classList.remove("spot"));
        t.classList.toggle("spot", on);
        $("#tiles").classList.toggle("has-spot", on);
        t.title = on ? "Click to show everyone" : "Click to enlarge";
      };
      t.onclick = () => {
        if (t.dataset.dragged) { delete t.dataset.dragged; return; } // that was a drag, not a click
        if (isSelf && floating()) return;
        spot();
      };
      if (isSelf) makeDraggable(t);
      t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); spot(); } };
      $("#tiles").append(t);
    }
    t.dataset.name = name;
    t.querySelector(".name").textContent = isSelf ? name + " (you)" : name;
    t.querySelector(".avatar span").textContent = initials(name);
    const v = t.querySelector("video");
    if (stream && v.srcObject !== stream) v.srcObject = stream;
    if (isSelf) t.querySelector(".ov").hidden = true;
    if (stream) watchVolume(t, stream);
    layout();
    return t;
  }

  function setTileState(t, state) {
    if (typeof state.mic === "boolean") t.dataset.mic = state.mic ? "1" : "0";
    if (typeof state.cam === "boolean") t.dataset.cam = state.cam ? "1" : "0";
    // A shared screen is shown whole; faces fill the tile.
    if (typeof state.share === "boolean") t.classList.toggle("sharing", state.share);
    refreshTile(t);
  }

  /** What a tile's person may do: from the roster, or the room defaults if they're not in it yet. */
  function allowFor(t) {
    if (t.id === "tile-self") return ALL; // your own preview always shows
    const p = roster.people.find((x) => x.id === t.dataset.pid);
    if (p) return p.allow;
    return t.dataset.host === "1" ? ALL : roster.defaults;
  }

  /** Shows a tile's video and plays its sound only if the person has it on AND the host allows it. */
  function refreshTile(t) {
    const a = allowFor(t);
    const sharing = t.classList.contains("sharing");
    const showVideo = t.dataset.cam !== "0" && (sharing ? a.share : a.cam);
    const v = t.querySelector("video");
    t.querySelector(".avatar").hidden = showVideo;
    v.style.visibility = showVideo ? "" : "hidden";
    t.querySelector(".muted-icon").style.display = t.dataset.mic !== "0" && a.mic ? "none" : "";
    if (t.id !== "tile-self") v.muted = !a.mic; // direct calls play sound through the tile
    // In RealtimeKit calls the SDK plays sound itself, so stop receiving it instead.
    if (rtk && t.dataset.rtkId && t.dataset.audioOff !== String(!a.mic)) {
      t.dataset.audioOff = String(!a.mic);
      (a.mic ? rtk.participants.subscribe([t.dataset.rtkId], ["audio"]) : rtk.participants.unsubscribe([t.dataset.rtkId], ["audio"])).catch((err) => console.warn("RealtimeKit audio", err));
    }
  }

  /* who is talking: a soft outline on their tile */
  let audioCtx = null;
  const meters = new Map();
  function watchVolume(tile, stream) {
    if (meters.has(tile) || !window.AudioContext) return;
    const attach = () => {
      if (!stream.getAudioTracks().length || meters.has(tile)) return;
      try {
        audioCtx = audioCtx || new AudioContext();
        const src = audioCtx.createMediaStreamSource(stream);
        const an = audioCtx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        meters.set(tile, { an, buf: new Uint8Array(an.fftSize), src });
      } catch { /* not supported */ }
    };
    attach();
    stream.addEventListener("addtrack", attach);
  }
  setInterval(() => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    for (const [tile, m] of meters) {
      if (!tile.isConnected) { try { m.src.disconnect(); } catch { /* ignore */ } meters.delete(tile); continue; }
      m.an.getByteTimeDomainData(m.buf);
      let peak = 0;
      for (const x of m.buf) peak = Math.max(peak, Math.abs(x - 128));
      const muted = tile.id === "tile-self" ? !micOn : tile.querySelector(".muted-icon").style.display !== "none";
      tile.classList.toggle("speaking", !muted && peak > 12);
    }
  }, 200);

  const floating = () => view === "speaker" && $("#tiles").children.length > 1;

  function layout() {
    const n = $("#tiles").children.length;
    const float = floating();
    if (float) { const s = $("#tile-self.spot"); if (s) { s.classList.remove("spot"); } }
    const shown = float ? n - 1 : n; // the floating self view doesn't take a place in the grid
    $("#tiles").className = "tiles " + (shown > 4 ? "nmany" : "n" + Math.max(shown, 1)) + ($("#tiles .tile.spot") ? " has-spot" : "") + (float ? " float-self pip-" + pipCorner : "");
    const self = $("#tile-self");
    if (self) self.title = float ? "Your camera. Drag it to another corner." : "Click to enlarge";
    const vb = $("#rview");
    vb.hidden = n < 2;
    vb.querySelector("use").setAttribute("href", view === "speaker" ? "#i-gallery" : "#i-speaker");
    vb.querySelector("span").textContent = view === "speaker" ? "Gallery" : "Speaker";
    vb.setAttribute("aria-label", view === "speaker" ? "Switch to gallery view" : "Switch to speaker view");
    $("#rcount").textContent = n === 1 ? "1 here" : n + " here";
    if (n !== lastCount && !$("#room").hidden) { lastCount = n; tellParent("people", { count: n }); }
    $("#wait").hidden = n > 1;
    applyBitrate();
  }

  function setView(v) {
    view = v;
    try { localStorage.setItem("meet-view", v); } catch { /* ignore */ }
    layout();
    toast(v === "speaker" ? "Speaker view: your camera is small" : "Gallery view: everyone the same size");
  }
  $("#rview").onclick = () => setView(view === "speaker" ? "gallery" : "speaker");

  /** Drag your floating camera; it snaps to the nearest corner when you let go. */
  function makeDraggable(t) {
    let start = null;
    t.addEventListener("pointerdown", (e) => {
      if (!floating() || e.button !== 0) return;
      const r = t.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      t.setPointerCapture(e.pointerId);
    });
    t.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      start.moved = true;
      const box = t.parentElement.parentElement.getBoundingClientRect(); // the stage
      const x = Math.min(Math.max(e.clientX - start.dx - box.left, 0), box.width - t.offsetWidth);
      const y = Math.min(Math.max(e.clientY - start.dy - box.top, 0), box.height - t.offsetHeight);
      t.classList.add("dragging");
      t.style.left = x + "px"; t.style.top = y + "px"; t.style.right = "auto"; t.style.bottom = "auto";
    });
    const end = (e) => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      if (!moved) return;
      t.dataset.dragged = "1";
      const box = t.parentElement.parentElement.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      const cx = r.left + r.width / 2 - box.left, cy = r.top + r.height / 2 - box.top;
      pipCorner = (cy < box.height / 2 ? "t" : "b") + (cx < box.width / 2 ? "l" : "r");
      try { localStorage.setItem("meet-pip", pipCorner); } catch { /* ignore */ }
      t.classList.remove("dragging");
      t.style.left = t.style.top = t.style.right = t.style.bottom = "";
      layout();
    };
    t.addEventListener("pointerup", end);
    t.addEventListener("pointercancel", end);
  }

  function applyBitrate() {
    const n = peers.size;
    const max = n <= 1 ? 1_500_000 : n === 2 ? 700_000 : 400_000;
    for (const p of peers.values()) {
      for (const s of p.pc.getSenders()) {
        if (!s.track || s.track.kind !== "video") continue;
        try {
          const prm = s.getParameters();
          if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
          if (prm.encodings[0].maxBitrate === max) continue;
          prm.encodings[0].maxBitrate = max;
          s.setParameters(prm).catch(() => {});
        } catch { /* not supported */ }
      }
    }
  }

  /* ---------- signalling ---------- */
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function connect() {
    clearTimeout(retryTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(join.token)}`);
    const mine = ws;
    let pingTimer;
    ws.onopen = () => { failures = 0; setState(""); if (pendingIntake) { mine.send(JSON.stringify({ type: "intake", text: pendingIntake })); pendingIntake = ""; } pingTimer = setInterval(() => { if (mine.readyState === 1) mine.send("ping"); }, 25000); };
    ws.onmessage = (e) => { if (e.data === "pong") return; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = async (e) => {
      clearInterval(pingTimer);
      if (mine !== ws || left) return;
      if (e.code === 4003) return hostEnded();
      if (e.code === 4001) return endCall("Opened somewhere else", "You joined this meeting from another window or device, so this one was disconnected.");
      if (e.code === 4002) return endCall("Meeting is full", "This meeting already has 4 people. Ask the host, or try again when someone leaves.");
      failures++;
      setState("Reconnecting…");
      if (failures >= 3) { // the join ticket may have expired; get a new one
        if (!(await fetchJoin(join.name))) return endCall("Disconnected", "We couldn't reconnect to the meeting.", true);
        failures = 0;
      }
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** failures, 8000));
    };
  }

  function setState(t) { const s = $("#rstate"); s.hidden = !t; s.textContent = t; }

  function onMessage(m) {
    if (m.type === "joined") {
      names.clear();
      for (const p of m.peers) names.set(p.id, p.name);
      if (m.mode === "rtk" || rtk || upgrading) { for (const id of [...peers.keys()]) dropPeer(id); return upgradeToRtk(); }
      const ids = new Set(m.peers.map((p) => p.id));
      for (const id of [...peers.keys()]) if (!ids.has(id)) dropPeer(id);
      // People already in the room wait for us; we call each of them.
      for (const p of m.peers) if (!peers.has(p.id)) { newPeer(p.id, p.name, p.host); callPeer(p.id).catch((err) => console.warn("call failed", err)); }
    } else if (m.type === "upgrade") {
      upgradeToRtk();
    } else if (m.type === "peer-joined" && (rtk || upgrading)) {
      names.set(m.id, m.name);
      toast(`${m.name || "Someone"} joined`);
    } else if (m.type === "peer-left" && (rtk || upgrading)) {
      toast(`${names.get(m.id) || "Someone"} left`);
      names.delete(m.id);
    } else if (m.type === "signal" && (rtk || upgrading)) {
      // direct-call messages don't apply any more
    } else if (m.type === "peer-joined") {
      names.set(m.id, m.name);
      // They'll send us an offer. Forget any stale connection to the same person (e.g. after a reload).
      dropPeer(m.id);
      newPeer(m.id, m.name, m.host);
      toast(`${m.name || "Someone"} joined`);
    } else if (m.type === "peer-left") {
      const p = peers.get(m.id);
      if (p) toast(`${p.name || "Someone"} left`);
      dropPeer(m.id);
    } else if (m.type === "signal") {
      handleSignal(m.from, m.data);
    } else if (m.type === "roster") {
      onRoster(m);
    } else if (m.type === "denied") {
      toast(m.perm === "chat" ? "The host has turned off chat for you" : "The host hasn't allowed that");
    } else if (m.type === "chat") {
      addChat(m.name, m.text, false);
    } else if (m.type === "ended") {
      hostEnded();
    } else if (m.type === "full") {
      endCall("Meeting is full", `This meeting already has ${m.max || 4} people.`);
    }
  }

  /* ---------- larger calls: Cloudflare RealtimeKit ---------- */
  function loadRtkSdk() {
    if (window.RealtimeKitClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "/vendor/realtimekit-2.0.4.js";
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error("couldn't load RealtimeKit"));
      document.head.append(sc);
    });
  }

  function upgradeToRtk() {
    if (rtk || upgrading) return upgrading;
    upgrading = (async () => {
      setState("Moving to a larger call…");
      toast("More people are joining, so the call is moving to Cloudflare's servers");
      // Stop the direct connections and give the camera/mic back, so RealtimeKit can use them.
      rtkDevices = { mic: !!audioTrack(), cam: !!videoTrack() };
      for (const id of [...peers.keys()]) dropPeer(id);
      if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      screenStream = null; sharing = false;
      try {
        await loadRtkSdk();
        let r = await api("/api/join/rtk", { room: code, key, name: join.name, link: joinLink || undefined });
        for (let i = 0; i < 3 && !r.ok && r.data.code === "not_upgraded"; i++) { // the room server may not have switched yet
          await new Promise((ok) => setTimeout(ok, 800));
          r = await api("/api/join/rtk", { room: code, key, name: join.name, link: joinLink || undefined });
        }
        if (!r.ok) throw new Error(r.data.error || "no token");
        const meeting = await window.RealtimeKitClient.init({
          authToken: r.data.token,
          defaults: { audio: micOn && rtkDevices.mic, video: camOn && rtkDevices.cam },
        });
        if (left) { meeting.leave().catch(() => {}); return; }
        rtk = meeting;
        wireRtk(meeting);
        await meeting.join();
        setState("");
        syncButtons();
        renderRtkSelf();
        for (const p of meeting.participants.joined.values()) renderRtkPeer(p);
      } catch (err) {
        console.error("Couldn't switch to RealtimeKit:", err);
        if (!left) endCall("Couldn't move the call", "The meeting grew past 4 people, but we couldn't move it to the larger-call service. Please rejoin.", true);
      } finally {
        upgrading = null;
      }
    })();
    return upgrading;
  }

  function wireRtk(meeting) {
    const J = meeting.participants.joined;
    J.on("participantJoined", (p) => renderRtkPeer(p));
    J.on("participantLeft", (p) => { const t = $("#tile-rtk-" + p.id); if (t) t.remove(); layout(); });
    for (const ev of ["videoUpdate", "audioUpdate", "screenShareUpdate"]) J.on(ev, (p) => renderRtkPeer(p));
    for (const ev of ["videoUpdate", "audioUpdate", "screenShareUpdate"]) meeting.self.on(ev, () => { micOn = !!meeting.self.audioEnabled; camOn = !!meeting.self.videoEnabled; sharing = !!meeting.self.screenShareEnabled; renderRtkSelf(); syncButtons(); });
    meeting.participants.on("activeSpeaker", ({ peerId }) => {
      const t = $("#tile-rtk-" + peerId);
      if (!t) return;
      t.classList.add("speaking");
      clearTimeout(t._speak);
      t._speak = setTimeout(() => t.classList.remove("speaking"), 1500);
    });
    // The browser may block sound until the page is tapped.
    meeting.self.on("autoplayError", () => {
      toast("Tap anywhere to hear the others");
      addEventListener("pointerdown", () => meeting.self.playAudio().catch(() => {}), { once: true });
    });
    meeting.self.on("roomLeft", ({ state }) => {
      if (left || rtk !== meeting) return;
      if (state === "kicked") endCall("Removed from the meeting", "The host removed you from this meeting.");
      else if (state === "ended") endCall("Meeting ended", "The meeting has ended.");
      else if (state === "failed" || state === "disconnected") endCall("Disconnected", "We lost the connection to the call.", true);
    });
  }

  function trackStream(track) { return track ? new MediaStream([track]) : null; }

  function renderRtkSelf() {
    if (!rtk) return;
    const me = rtk.self;
    const t = addTile("self", join.name, null, true);
    const v = t.querySelector("video");
    const track = me.screenShareEnabled && me.screenShareTracks && me.screenShareTracks.video ? me.screenShareTracks.video : me.videoEnabled ? me.videoTrack : null;
    if (!track || !v.srcObject || v.srcObject.getVideoTracks()[0] !== track) v.srcObject = trackStream(track);
    setTileState(t, { mic: !!me.audioEnabled, cam: !!track, share: !!me.screenShareEnabled });
  }

  function renderRtkPeer(p) {
    if (!rtk || p.id === rtk.self.id) return;
    const t = addTile("rtk-" + p.id, (p.name || "Guest") + (p.isHost ? " (host)" : ""), null, false);
    t.dataset.pid = p.customParticipantId || "";
    t.dataset.rtkId = p.id;
    t.dataset.host = p.isHost ? "1" : "";
    t.querySelector(".ov").hidden = true;
    const v = t.querySelector("video");
    const share = !!(p.screenShareEnabled && p.screenShareTracks && p.screenShareTracks.video);
    const track = share ? p.screenShareTracks.video : p.videoEnabled ? p.videoTrack : null;
    if (!track) v.srcObject = null;
    else if (!v.srcObject || v.srcObject.getVideoTracks()[0] !== track) { v.srcObject = trackStream(track); v.play().catch(() => {}); }
    setTileState(t, { mic: !!p.audioEnabled, cam: !!track, share });
  }

  /* ---------- peer connections ---------- */
  function newPeer(id, name, host) {
    const pc = new RTCPeerConnection({ iceServers: join.iceServers, iceTransportPolicy: join.relayOnly ? "relay" : "all", bundlePolicy: "max-bundle" });
    const p = { id, name, host, pc, stream: new MediaStream(), queue: Promise.resolve(), pending: [], connectedOnce: false };
    peers.set(id, p);
    const tile = addTile(id, name + (host ? " (host)" : ""), p.stream, false);
    tile.dataset.pid = id;
    tile.dataset.host = host ? "1" : "";
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: id, data: { candidate: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      p.stream.addTrack(e.track);
      const v = tile.querySelector("video");
      v.srcObject = p.stream;
      v.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const ov = tile.querySelector(".ov");
      if (s === "connected") { p.connectedOnce = true; ov.hidden = true; applyBitrate(); broadcastState(); }
      else if (s === "failed" || s === "disconnected") {
        ov.hidden = false; ov.textContent = "Reconnecting…";
        // Whoever has the larger id re-calls, so both sides never offer at once.
        if (s === "failed" && pid > id && peers.get(id) === p) { dropPeer(id); newPeer(id, name, host); callPeer(id).catch(() => {}); }
      } else if (s === "connecting" || s === "new") { ov.hidden = p.connectedOnce; ov.textContent = "Connecting…"; }
    };
    layout();
    return p;
  }

  function dropPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
    const t = $("#tile-" + id);
    if (t) t.remove();
    layout();
  }

  async function callPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    const pc = p.pc;
    for (const kind of ["audio", "video"]) {
      const tr = pc.addTransceiver(kind, { direction: "sendrecv" });
      const t = kind === "audio" ? audioTrack() : (sharing && screenStream ? screenStream.getVideoTracks()[0] : videoTrack());
      if (t) await tr.sender.replaceTrack(t);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "signal", to: id, data: { sdp: pc.localDescription.toJSON() } });
    applyBitrate();
  }

  function handleSignal(from, data) {
    // Someone muted, unmuted or switched their camera.
    if (data.state && typeof data.state === "object") {
      const t = $("#tile-" + from);
      if (t && peers.has(from)) setTileState(t, { mic: data.state.mic === true, cam: data.state.cam === true, share: data.state.share === true });
      return;
    }
    const isOffer = data.sdp && data.sdp.type === "offer";
    let p = peers.get(from);
    // A fresh offer on a connection that already negotiated means that person is calling us again: start clean.
    if (p && isOffer && p.pc.remoteDescription) { const { name, host } = p; dropPeer(from); p = newPeer(from, name, host); }
    if (!p && isOffer) p = newPeer(from, "Guest", false);
    if (!p) return;
    p.queue = p.queue.then(() => processSignal(p, data)).catch((err) => console.warn("signal failed", err));
  }

  async function processSignal(p, data) {
    const pc = p.pc;
    if (data.sdp) {
      if (data.sdp.type === "offer") {
        if (pc.signalingState !== "stable") return; // we're the one who called; ignore a stray offer
        await pc.setRemoteDescription(data.sdp);
        for (const tr of pc.getTransceivers()) {
          const kind = tr.receiver.track.kind;
          tr.direction = "sendrecv";
          const t = kind === "audio" ? audioTrack() : (sharing && screenStream ? screenStream.getVideoTracks()[0] : videoTrack());
          if (t) await tr.sender.replaceTrack(t);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: "signal", to: p.id, data: { sdp: pc.localDescription.toJSON() } });
        for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        applyBitrate();
      } else if (data.sdp.type === "answer") {
        if (pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription(data.sdp);
        for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
    }
  }

  /* ---------- screen sharing ---------- */
  async function setVideoSource(track) {
    for (const p of peers.values()) {
      for (const tr of p.pc.getTransceivers()) {
        if (tr.receiver.track && tr.receiver.track.kind === "video" && tr.sender) await tr.sender.replaceTrack(track).catch(() => {});
      }
    }
    const self = $("#tile-self video");
    if (self) self.srcObject = track ? new MediaStream([track]) : localStream;
  }
  async function startShare() {
    if (!myAllow.share) return toast("The host has turned off screen sharing for you");
    if (rtk) { try { await rtk.self.enableScreenShare(); toast("You're sharing your screen"); } catch { /* cancelled */ } return; }
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false }); } catch { return; }
    const t = screenStream.getVideoTracks()[0];
    t.onended = stopShare;
    sharing = true;
    await setVideoSource(t);
    syncButtons();
    broadcastState();
    toast("You're sharing your screen");
  }
  async function stopShare() {
    if (rtk) { try { await rtk.self.disableScreenShare(); } catch { /* ignore */ } return; }
    if (!sharing) return;
    sharing = false;
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    await setVideoSource(videoTrack() || null);
    syncButtons();
    broadcastState();
  }
  $("#cshare").onclick = () => (sharing ? stopShare() : startShare());

  /* ---------- people and permissions ---------- */
  const PERM_INFO = [
    ["mic", "Mic", "#i-mic", "microphone"],
    ["cam", "Camera", "#i-cam", "camera"],
    ["share", "Share", "#i-share", "screen sharing"],
    ["chat", "Chat", "#i-chat", "chat"],
  ];

  const seenIntakes = new Map();
  function onRoster(m) {
    for (const p of Array.isArray(m.people) ? m.people : []) {
      if (p.intake && seenIntakes.get(p.id) !== p.intake) {
        seenIntakes.set(p.id, p.intake);
        if (amHost()) toast(`${p.name || "A guest"}: “${p.intake.length > 80 ? p.intake.slice(0, 80) + "…" : p.intake}”`);
      }
    }
    roster = { defaults: { ...ALL, ...(m.defaults || {}) }, people: Array.isArray(m.people) ? m.people : [] };
    const me = roster.people.find((p) => p.id === pid);
    const before = myAllow;
    myAllow = amHost() || !me ? { ...ALL } : { ...ALL, ...me.allow };
    const OFF = { mic: "The host turned off your microphone", cam: "The host turned off your camera", share: "The host turned off screen sharing for you", chat: "The host turned off chat for you" };
    const ON = { mic: "The host allowed your microphone again", cam: "The host allowed your camera again", share: "The host allowed you to share your screen", chat: "The host allowed you to chat again" };
    // Only announce changes, not what was already set when you arrived.
    if (rosterSeen) for (const [perm] of PERM_INFO) {
      if (before[perm] && !myAllow[perm]) toast(OFF[perm]);
      else if (!before[perm] && myAllow[perm]) toast(ON[perm]);
    }
    rosterSeen = true;
    // Switch off anything that's no longer allowed. (Being allowed again never switches anything on by itself.)
    if (!myAllow.mic && micOn) toggleMic();
    if (!myAllow.cam && camOn) toggleCam();
    if (!myAllow.share && sharing) stopShare();
    syncButtons();
    syncChatPerm();
    document.querySelectorAll("#tiles .tile").forEach(refreshTile);
    renderPeople();
  }

  function syncChatPerm() {
    const ok = myAllow.chat;
    $("#cinput").disabled = !ok;
    $("#cform button").disabled = !ok;
    $("#cinput").placeholder = ok ? "Message everyone" : "The host has turned off chat for you";
  }

  function permButton(target, perm, label, icon, allowed, words, who) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pperm";
    b.setAttribute("aria-pressed", String(allowed));
    b.setAttribute("aria-label", `${who}: ${words} ${allowed ? "allowed" : "not allowed"}`);
    b.title = allowed ? `Allowed. Click to stop ${who === "Everyone" ? "everyone's" : "their"} ${words}.` : `Not allowed. Click to allow ${words}.`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", icon);
    svg.append(use);
    b.append(svg, label);
    b.onclick = () => send({ type: "perm", target, perm, allow: !allowed });
    return b;
  }

  function renderPeople() {
    const host = amHost();
    const list = [...roster.people].sort((a, b) => (b.id === pid) - (a.id === pid) || b.host - a.host || a.name.localeCompare(b.name));
    $("#ptitle").textContent = `People (${list.length || 1})`;
    $("#phint").textContent = host ? "Choose what each person can do. “Everyone” sets it for the whole room, including people who join later. You're never restricted." : "Only the host can change what people can do.";
    const all = $("#pall");
    all.hidden = !host;
    all.textContent = "";
    if (host) {
      const n = document.createElement("div"); n.className = "pname"; n.append(Object.assign(document.createElement("span"), { textContent: "Everyone" }));
      const row = document.createElement("div"); row.className = "pperms";
      for (const [perm, label, icon, words] of PERM_INFO) row.append(permButton("*", perm, label, icon, roster.defaults[perm], words, "Everyone"));
      all.append(n, row);
    }
    const ul = $("#plist");
    ul.textContent = "";
    for (const p of list) {
      const li = document.createElement("li"); li.className = "prow";
      const n = document.createElement("div"); n.className = "pname";
      n.append(Object.assign(document.createElement("span"), { textContent: p.name || "Guest" }));
      const tags = [p.id === pid ? "you" : "", p.host ? "host" : ""].filter(Boolean).join(", ");
      if (tags) n.append(Object.assign(document.createElement("small"), { textContent: `(${tags})` }));
      li.append(n);
      if (host && p.intake) li.append(Object.assign(document.createElement("blockquote"), { className: "pintake", textContent: p.intake }));
      if (host && !p.host) {
        const row = document.createElement("div"); row.className = "pperms";
        for (const [perm, label, icon, words] of PERM_INFO) row.append(permButton(p.id, perm, label, icon, p.allow[perm], words, p.name || "Guest"));
        li.append(row);
      } else if (!p.host) {
        const off = PERM_INFO.filter(([perm]) => !p.allow[perm]).map(([, , , words]) => words);
        if (off.length) li.append(Object.assign(document.createElement("div"), { className: "pnote", textContent: `Not allowed: ${off.join(", ")}` }));
      }
      ul.append(li);
    }
  }

  function setPeople(open) {
    if (open) setChat(false);
    $("#people").hidden = !open;
    $("#rpeople").setAttribute("aria-pressed", String(open));
    if (open) renderPeople();
  }
  $("#rpeople").onclick = () => setPeople($("#people").hidden);
  $("#pclose").onclick = () => setPeople(false);

  /* ---------- chat ---------- */
  function setUnread(n) {
    unread = n;
    $("#cbadge").hidden = !n;
    $("#cbadge").textContent = n > 9 ? "9+" : String(n);
    $("#cchat").setAttribute("aria-label", n ? `Chat, ${n} unread` : "Chat");
  }
  function addChat(name, text, mine) {
    $("#cempty").hidden = true;
    const li = document.createElement("li");
    if (mine) li.className = "me";
    const w = document.createElement("span");
    w.className = "who"; w.textContent = mine ? "You" : name;
    const s = document.createElement("span");
    s.className = "msg"; s.textContent = text;
    li.append(w, s);
    $("#clog").append(li);
    $("#clog").scrollTop = $("#clog").scrollHeight;
    if (!mine && $("#chat").hidden) { setUnread(unread + 1); toast(`${name}: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`); }
  }
  function setChat(open) {
    if (open && !$("#people").hidden) setPeople(false);
    $("#chat").hidden = !open;
    $("#cchat").setAttribute("aria-pressed", String(open));
    if (open) { setUnread(0); $("#cinput").focus(); $("#clog").scrollTop = $("#clog").scrollHeight; }
  }
  $("#cchat").onclick = () => setChat($("#chat").hidden);
  $("#cclose").onclick = () => setChat(false);
  $("#cform").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#cinput").value.trim();
    if (!text) return;
    if (!myAllow.chat) return toast("The host has turned off chat for you");
    send({ type: "chat", text });
    addChat(join.name, text, true);
    $("#cinput").value = "";
  };

  /* ---------- keyboard ---------- */
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#chat").hidden) return setChat(false);
      if (!$("#people").hidden) return setPeople(false);
      const s = $(".tile.spot"); if (s) s.click();
      return;
    }
    if (typing() || e.ctrlKey || e.metaKey || e.altKey) return;
    const inCall = !$("#room").hidden, inLobby = !$("#lobby").hidden;
    if (!inCall && !inLobby) return;
    const k = e.key.toLowerCase();
    if (k === "m" && hasMic()) { e.preventDefault(); if (!micOn && !myAllow.mic) toggleMic(); else { toggleMic(); toast(micOn ? "Microphone on" : "Microphone muted"); } }
    else if (k === "g" && inCall && $("#tiles").children.length > 1) { e.preventDefault(); setView(view === "speaker" ? "gallery" : "speaker"); }
    else if (k === "v" && hasCam()) { e.preventDefault(); if (!camOn && !myAllow.cam) toggleCam(); else { toggleCam(); toast(camOn ? "Camera on" : "Camera off"); } }
  });

  /* ---------- leaving ---------- */
  function cleanup() {
    left = true;
    clearTimeout(retryTimer);
    try { if (ws) ws.close(1000, "bye"); } catch { /* ignore */ }
    for (const id of [...peers.keys()]) dropPeer(id);
    if (rtk) { rtk.leave().catch(() => {}); rtk = null; }
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = screenStream = null; sharing = false;
    $("#tiles").textContent = "";
    setChat(false);
    setPeople(false);
  }
  function endCall(title, text, retry) { cleanup(); notice(title, text, retry); tellParent("ended", { reason: title }); }
  function leaveNow() { cleanup(); notice("You left the meeting", "You can rejoin any time while it's open.", true); tellParent("left"); }
  // Hosts choose: just leave, or end the meeting for everyone (guests then go to the host's after-call page, if set).
  $("#cleave").onclick = (e) => {
    if (!amHost()) return leaveNow();
    e.stopPropagation();
    $("#leavemenu").hidden = !$("#leavemenu").hidden;
    if (!$("#leavemenu").hidden) $("#lmleave").focus();
  };
  $("#lmleave").onclick = () => { $("#leavemenu").hidden = true; leaveNow(); };
  $("#lmend").onclick = () => {
    $("#leavemenu").hidden = true;
    send({ type: "end" });
    setTimeout(() => {
      cleanup();
      notice("You ended the meeting", info.redirectUrl ? "Everyone else has been sent to your after-call page." : "Everyone has been disconnected.", true);
      tellParent("ended", { reason: "you_ended" });
    }, 150); // give the message a moment to go out
  };
  addEventListener("click", (e) => { if (!$("#leavemenu").hidden && !e.target.closest("#leavemenu")) $("#leavemenu").hidden = true; });

  function hostEnded() {
    if (left) return;
    cleanup();
    const url = info && info.redirectUrl;
    tellParent("ended", { reason: "host_ended", redirectUrl: url || undefined });
    if (!url) return notice("The meeting has ended", "The host ended the meeting for everyone.");
    let where = "the next page";
    try { where = new URL(url).hostname; } catch { /* ignore */ }
    notice("The meeting has ended", `Thanks for joining. Taking you to ${where}…`);
    const go = $("#ngo");
    go.href = url;
    go.hidden = false;
    go.textContent = "Continue";
    if (embedded) {
      // Inside another site's page: open it over that page when they click (pages like Stripe can't load in a frame).
      go.target = "_top";
      $("#ntext").textContent = `Thanks for joining. Continue to ${where}.`;
      return;
    }
    let n = 3;
    const tick = () => {
      if (n <= 0) { location.href = url; return; }
      $("#ntext").textContent = `Thanks for joining. Taking you to ${where} in ${n}…`;
      n--;
      setTimeout(tick, 1000);
    };
    tick();
  }
  $("#nretry").onclick = () => location.reload();
  addEventListener("pagehide", () => { if (rtk) rtk.leave().catch(() => {}); if (ws) try { ws.close(1000, "bye"); } catch { /* ignore */ } });
  // If a policy ever blocks something the call needs, say so in the console (helps when setting up RealtimeKit).
  addEventListener("securitypolicyviolation", (e) => console.warn("Blocked by the site's security policy:", e.blockedURI, e.violatedDirective));

  start();
})();
