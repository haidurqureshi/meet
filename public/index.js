// Landing page: paste a link to join.
App.boot();
document.getElementById("join").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = App.roomCode(document.getElementById("code").value);
  if (!c) return App.show(document.getElementById("msg"), "error", "That doesn't look like a meeting link.");
  location.href = "/m/" + c;
});
