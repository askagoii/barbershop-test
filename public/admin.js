const $ = id => document.getElementById(id);
let es;
async function load() {
  const r = await fetch("/api/admin/bookings");
  if (r.status === 401) { $("login").hidden = false; $("app").hidden = true; return false; }
  $("login").hidden = true; $("app").hidden = false;
  const rows = await r.json(), list = $("list"); list.innerHTML = "";
  if (!rows.length) list.innerHTML = '<p class="hint">Ирэх захиалга алга.</p>';
  let last = "";
  rows.forEach(b => {
    if (b.date !== last) {
      last = b.date; const h = document.createElement("div"); h.className = "dayhead";
      h.textContent = new Date(b.date + "T00:00").toLocaleDateString("mn", { weekday: "long", month: "long", day: "numeric" }); list.append(h);
    }
    const row = document.createElement("div"); row.className = "row";
    const t = document.createElement("b"); t.textContent = b.time;
    const mid = document.createElement("div"), nm = document.createElement("b"), sm = document.createElement("small");
    nm.textContent = b.name; sm.textContent = `${b.service} · ${b.barber} · ${b.phone}${b.email ? " · " + b.email : ""}`; mid.append(nm, sm);
    const del = document.createElement("button"); del.textContent = "Цуцлах";
    del.onclick = async () => { if (confirm(b.name + "-ийн захиалгыг цуцлах уу?")) await fetch("/api/admin/booking/" + b.id, { method: "DELETE" }); };
    row.append(t, mid, del); list.append(row);
  });
  return true;
}
function stream() {
  if (es) es.close();
  es = new EventSource("/api/admin/stream");
  es.onmessage = () => load();
  es.onopen = () => $("live").textContent = "Шууд: шинэчлэлт даруй харагдана";
  es.onerror = () => $("live").textContent = "Дахин холбогдож байна…";
}
$("in").onclick = async () => {
  const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("pw").value }) });
  if (r.ok) { $("pw").value = ""; if (await load()) stream(); } else $("err").textContent = (await r.json()).error;
};
$("out").onclick = async () => { await fetch("/api/admin/logout", { method: "POST" }); if (es) es.close(); load(); };
load().then(ok => ok && stream());