const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const ft = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
let C, taken = new Set();
const S = { service: null, barber: null, date: null, time: null };

async function loadTaken() {
  taken = new Set();
  if (S.date && S.barber) taken = new Set(await (await fetch(`/api/taken?date=${S.date}&barber=${S.barber}`)).json());
  draw();
}
function opts(el, items, key, sub) {
  el.innerHTML = "";
  items.forEach(it => {
    const b = document.createElement("button"); b.className = "opt";
    b.setAttribute("aria-pressed", String(S[key] === it.id));
    const t = document.createElement("b"); t.textContent = it.name; b.append(t);
    if (sub) { const s = document.createElement("span"); s.textContent = sub(it); b.append(s); }
    b.onclick = () => { S[key] = it.id; S.time = null; key === "barber" ? loadTaken() : draw(); };
    el.append(b);
  });
}
function draw() {
  opts($("services"), C.services, "service", s => `${s.min} мин · €${s.price}`);
  opts($("barbers"), C.barbers, "barber");
  const dEl = $("days"), keep = dEl.scrollLeft; dEl.innerHTML = "";
  const t = new Date(); t.setHours(0, 0, 0, 0);
  for (let i = 0; i < 21; i++) {
    const d = new Date(t); d.setDate(t.getDate() + i);
    const b = document.createElement("button"); b.className = "day"; b.disabled = d.getDay() === 0;
    b.setAttribute("aria-pressed", String(S.date === iso(d)));
    b.innerHTML = `<small>${d.toLocaleDateString("mn", { weekday: "short" })}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString("mn", { month: "short" })}</small>`;
    b.onclick = () => { S.date = iso(d); S.time = null; loadTaken(); };
    dEl.append(b);
  }
  dEl.scrollLeft = keep;
  const el = $("slots"); el.innerHTML = ""; $("hint").textContent = "";
  const s = C.services.find(x => x.id === S.service);
  if (!s || !S.date) $("hint").textContent = "Үйлчилгээ болон огноогоо сонгоход сул цагууд харагдана.";
  else {
    const n = Math.ceil(s.min / C.step), now = new Date(), today = S.date === iso(now), nm = now.getHours() * 60 + now.getMinutes();
    let free = 0;
    for (let m = C.open; m + n * C.step <= C.close; m += C.step) {
      let off = today && m <= nm;
      for (let i = 0; i < n; i++) if (taken.has(m + i * C.step)) off = true;
      const b = document.createElement("button"); b.className = "slot"; b.textContent = ft(m); b.disabled = off;
      if (!off) free++;
      b.setAttribute("aria-pressed", String(S.time === m));
      b.onclick = () => { S.time = m; draw(); };
      el.append(b);
    }
    if (!free) $("hint").textContent = "Тэр өдөр сул цаг байхгүй. Өөр өдөр эсвэл үсчин сонгоно уу.";
  }
  $("go").disabled = !(S.service && S.barber && S.date && S.time !== null);
}
$("go").onclick = async () => {
  $("go").disabled = true; $("err").textContent = "";
  const r = await fetch("/api/book", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: S.service, barber: S.barber, date: S.date, start: S.time, name: $("name").value, phone: $("phone").value, email: $("email").value }),
  });
  const j = await r.json();
  if (r.ok) location.href = "/manage.html?code=" + j.code + "&new=1";
  else { $("err").textContent = j.error; S.time = null; await loadTaken(); }
};
(async () => { C = await (await fetch("/api/config")).json(); S.barber = C.barbers[0].id; draw(); })();