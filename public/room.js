// Meeting room: up to 4 people, every pair connected directly (through Cloudflare TURN relays).
(function () {
  const { $, api, show, toast } = App;
  const code = (/^\/m\/([a-z2-9]{12})$/.exec(location.pathname) || [])[1];
  const keyName = "meet-key-" + code;
  let info = null, join = null, ws = null, localStream = null, screenStream = null;
  let micOn = true, camOn = true, sharing = false, left = false, failures = 0, retryTimer = null, unread = 0;
  const peers = new Map();
  // A secret per meeting tab: the server turns it into our id in the room, so a reload keeps our place
  // but nobody else can take it. Only our id (never this key) is shown to the others.
  let pid = "", key = "";
  try { key = sessionStorage.getItem(keyName) || ""; } catch { /* storage blocked */ }

  const panel = (id) => {
    ["loading", "notice", "lobby", "room"].forEach((p) => ($("#" + p).hidden = p !== id));
    document.body.classList.toggle("in-call", id === "room");
  };
  function notice(title, text, retry) {
    panel("notice");
    $("#ntitle").textContent = title;
    $("#ntext").textContent = text;
    $("#nretry").hidden = !retry;
    document.title = title;
  }
  const initials = (name) => (String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"); };

  /* ---------- lobby ---------- */
  async function start() {
    if (!code) return notice("No meeting here", "Open the full meeting link you were sent, or go home and paste it.");
    const r = await api("/api/room/" + code);
    if (!r.ok) return notice("Meeting not found", r.data.error || "Check you copied the whole link.");
    info = r.data;
    document.title = info.title;
    if (info.status === "unavailable") return notice("Not available", "This meeting can't be started right now. Ask the host to check their account.");
    if (info.status === "over") return notice("Meeting finished", "This meeting has ended. Ask the host for a new link.");
    if (info.status === "early") {
      const when = info.startsAt ? new Date(info.startsAt).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
      return notice("Not open yet", `"${info.title}" starts ${when}. The room opens 15 minutes before. Come back then.`);
    }
    panel("lobby");
    $("#ltitle").textContent = info.title;
    $("#lhost").textContent = info.isHost ? "You're the host" : `Hosted by ${info.hostName}`;
    let saved = "";
    try { saved = localStorage.getItem("meet-name") || ""; } catch { /* ignore */ }
    $("#lname").value = info.userName || saved;
    getMedia().then(() => { if (!$("#lname").value) $("#lname").focus(); else $("#ljoin").focus(); });
  }

  async function getMedia() {
    if (localStream) return;
    $("#lnocam").hidden = false;
    $("#lnocam").textContent = "Starting your camera…";
    const tries = [
      { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } } },
      { audio: true, video: false },
    ];
    for (const c of tries) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (err) { /* try the next, simpler request */ }
    }
    if (!localStream) {
      localStream = new MediaStream();
      $("#lnocam").textContent = "No camera or microphone. Check the browser's permission (the icon in the address bar) and reload. You can still watch and chat.";
      show($("#lmsg"), "error", "We couldn't use your camera or microphone, so others won't see or hear you.");
    } else {
      if (!localStream.getVideoTracks().length) $("#lnocam").textContent = "No camera found. You'll join with sound only.";
      else $("#lnocam").hidden = true;
      $("#lpreview").srcObject = localStream;
    }
    syncButtons();
  }

  const audioTrack = () => localStream && localStream.getAudioTracks()[0];
  const videoTrack = () => localStream && localStream.getVideoTracks()[0];

  function syncButtons() {
    const a = audioTrack(), v = videoTrack();
    for (const [id, on, onText, offText, has] of [["lmic", micOn, "Mute", "Unmute", a], ["cmic", micOn, "Mute", "Unmute", a], ["lcam", camOn, "Stop video", "Start video", v], ["ccam", camOn, "Stop video", "Start video", v]]) {
      const b = $("#" + id);
      b.disabled = !has;
      b.setAttribute("aria-pressed", String(!on || !has));
      b.querySelector(".lbl").textContent = !has ? (id.endsWith("mic") ? "No mic" : "No camera") : on ? onText : offText;
    }
    if (a) a.enabled = micOn;
    if (v) v.enabled = camOn;
    const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $("#cshare").hidden = !canShare; // phones can't share their screen
    $("#cshare").querySelector(".lbl").textContent = sharing ? "Stop share" : "Share";
    $("#cshare").setAttribute("aria-pressed", String(sharing));
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
  const toggleMic = () => { micOn = !micOn; syncButtons(); broadcastState(); };
  const toggleCam = () => { camOn = !camOn; syncButtons(); broadcastState(); };
  $("#lmic").onclick = $("#cmic").onclick = toggleMic;
  $("#lcam").onclick = $("#ccam").onclick = toggleCam;

  $("#lform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#lname").value.trim();
    if (!name) { $("#lname").focus(); return show($("#lmsg"), "error", "Please type your name."); }
    App.busy($("#ljoin"), true);
    show($("#lmsg"), "", "");
    try { localStorage.setItem("meet-name", name); } catch { /* ignore */ }
    const ok = await fetchJoin(name);
    App.busy($("#ljoin"), false);
    if (ok) enterRoom(name);
  });

  async function fetchJoin(name) {
    const r = await api("/api/join", { room: code, name, key });
    if (!r.ok) { show($("#lmsg"), "error", r.data.error || "Couldn't join."); if (r.status === 410 || r.status === 403) notice("Can't join", r.data.error); return false; }
    join = r.data;
    pid = join.pid;
    key = join.key;
    try { sessionStorage.setItem(keyName, key); } catch { /* ignore */ }
    join.name = name;
    return true;
  }

  /* ---------- room UI ---------- */
  const meetingLink = () => location.origin + "/m/" + code;
  function enterRoom(name) {
    panel("room");
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
      t.onclick = spot;
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
    if (typeof state.mic === "boolean") t.querySelector(".muted-icon").style.display = state.mic ? "none" : "";
    if (typeof state.cam === "boolean") {
      t.querySelector(".avatar").hidden = state.cam;
      t.querySelector("video").style.visibility = state.cam ? "" : "hidden";
    }
    // A shared screen is shown whole; faces fill the tile.
    if (typeof state.share === "boolean") t.classList.toggle("sharing", state.share);
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

  function layout() {
    const n = $("#tiles").children.length;
    $("#tiles").className = "tiles n" + Math.min(Math.max(n, 1), 4) + ($("#tiles .tile.spot") ? " has-spot" : "");
    $("#rcount").textContent = n === 1 ? "1 here" : n + " here";
    $("#wait").hidden = n > 1;
    applyBitrate();
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
    ws.onopen = () => { failures = 0; setState(""); pingTimer = setInterval(() => { if (mine.readyState === 1) mine.send("ping"); }, 25000); };
    ws.onmessage = (e) => { if (e.data === "pong") return; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = async (e) => {
      clearInterval(pingTimer);
      if (mine !== ws || left) return;
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
      const ids = new Set(m.peers.map((p) => p.id));
      for (const id of [...peers.keys()]) if (!ids.has(id)) dropPeer(id);
      // People already in the room wait for us; we call each of them.
      for (const p of m.peers) if (!peers.has(p.id)) { newPeer(p.id, p.name, p.host); callPeer(p.id).catch((err) => console.warn("call failed", err)); }
    } else if (m.type === "peer-joined") {
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
    } else if (m.type === "chat") {
      addChat(m.name, m.text, false);
    } else if (m.type === "full") {
      endCall("Meeting is full", "This meeting already has 4 people.");
    }
  }

  /* ---------- peer connections ---------- */
  function newPeer(id, name, host) {
    const pc = new RTCPeerConnection({ iceServers: join.iceServers, iceTransportPolicy: join.relayOnly ? "relay" : "all", bundlePolicy: "max-bundle" });
    const p = { id, name, host, pc, stream: new MediaStream(), queue: Promise.resolve(), pending: [], connectedOnce: false };
    peers.set(id, p);
    const tile = addTile(id, name + (host ? " (host)" : ""), p.stream, false);
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
    if (!sharing) return;
    sharing = false;
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    await setVideoSource(videoTrack() || null);
    syncButtons();
    broadcastState();
  }
  $("#cshare").onclick = () => (sharing ? stopShare() : startShare());

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
    send({ type: "chat", text });
    addChat(join.name, text, true);
    $("#cinput").value = "";
  };

  /* ---------- keyboard ---------- */
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#chat").hidden) return setChat(false);
      const s = $(".tile.spot"); if (s) s.click();
      return;
    }
    if (typing() || e.ctrlKey || e.metaKey || e.altKey) return;
    const inCall = !$("#room").hidden, inLobby = !$("#lobby").hidden;
    if (!inCall && !inLobby) return;
    const k = e.key.toLowerCase();
    if (k === "m" && audioTrack()) { e.preventDefault(); toggleMic(); toast(micOn ? "Microphone on" : "Microphone muted"); }
    else if (k === "v" && videoTrack()) { e.preventDefault(); toggleCam(); toast(camOn ? "Camera on" : "Camera off"); }
  });

  /* ---------- leaving ---------- */
  function cleanup() {
    left = true;
    clearTimeout(retryTimer);
    try { if (ws) ws.close(1000, "bye"); } catch { /* ignore */ }
    for (const id of [...peers.keys()]) dropPeer(id);
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = screenStream = null; sharing = false;
    $("#tiles").textContent = "";
    setChat(false);
  }
  function endCall(title, text, retry) { cleanup(); notice(title, text, retry); }
  $("#cleave").onclick = () => { cleanup(); notice("You left the meeting", "You can rejoin any time while it's open.", true); };
  $("#nretry").onclick = () => location.reload();
  addEventListener("pagehide", () => { if (ws) try { ws.close(1000, "bye"); } catch { /* ignore */ } });

  start();
})();
