const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!ADMIN_PASSWORD) { console.error("Set ADMIN_PASSWORD first."); process.exit(1); }

// ---- Shop settings: edit these ----
const OPEN = 9 * 60, CLOSE = 18 * 60, STEP = 30, DAYS_AHEAD = 60;
const SERVICES = [
  { id: "cut",   name: "Үс засалт",          min: 30, price: 18 },
  { id: "beard", name: "Сахал засалт",       min: 20, price: 12 },
  { id: "both",  name: "Үс + сахал",         min: 45, price: 27 },
  { id: "kids",  name: "Хүүхдийн үс засалт", min: 25, price: 13 },
];
const BARBERS = [{ id: "mark", name: "Márk" }, { id: "lili", name: "Lili" }, { id: "gabor", name: "Gábor" }];
// -----------------------------------

const db = new Database(path.join(__dirname, "bookings.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, date TEXT NOT NULL, start INTEGER NOT NULL,
  service TEXT NOT NULL, barber TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS slots(
  date TEXT NOT NULL, min INTEGER NOT NULL, barber TEXT NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY(date, min, barber));
`);

// ---- Email (optional) ----
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = require("nodemailer").createTransport({
    host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function mail(to, subject, text) {
  if (!mailer || !to) return;
  mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, text }).catch(e => console.error("Mail error:", e.message));
}

// ---- Helpers ----
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const clean = (s, max) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const svc = id => SERVICES.find(s => s.id === id);
const barber = id => BARBERS.find(b => b.id === id);

// Live updates for the barber dashboard (Server-Sent Events)
const clients = new Set();
const broadcast = () => clients.forEach(res => res.write("data: change\n\n"));

// Simple rate limit for booking (per IP)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); hits.set(ip, list);
  return list.length > 8;
}

// ---- Admin auth: signed cookie ----
const token = crypto.createHmac("sha256", SECRET).update("admin").digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function isAdmin(req) {
  const m = /(?:^|;\s*)admin=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return !!m && safeEq(m[1], token);
}
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: "Нэвтрээгүй байна" });

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Public API ----
app.get("/api/config", (_, res) =>
  res.json({ services: SERVICES, barbers: BARBERS, open: OPEN, close: CLOSE, step: STEP, daysAhead: DAYS_AHEAD }));

app.get("/api/taken", (req, res) => {
  const rows = db.prepare("SELECT min FROM slots WHERE date=? AND barber=?").all(clean(req.query.date, 10), clean(req.query.barber, 20));
  res.json(rows.map(r => r.min));
});

app.post("/api/book", (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Хэт олон оролдлого хийлээ. Дараа дахин оролдоно уу." });
  const b = req.body || {};
  const s = svc(b.service), br = barber(b.barber);
  const name = clean(b.name, 80), phone = clean(b.phone, 30), email = clean(b.email, 120);
  const date = clean(b.date, 10), start = Number(b.start);
  if (!s || !br) return res.status(400).json({ error: "Үйлчилгээ болон үсчнээ сонгоно уу." });
  if (name.length < 2) return res.status(400).json({ error: "Нэрээ оруулна уу." });
  if (!/^[0-9+ ()\-]{7,30}$/.test(phone)) return res.status(400).json({ error: "Утасны дугаараа зөв оруулна уу." });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Имэйл хаяг буруу байна." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Огноогоо сонгоно уу." });

  const now = new Date(), today = iso(now), d = new Date(date + "T00:00");
  const last = new Date(); last.setDate(last.getDate() + DAYS_AHEAD);
  const n = Math.ceil(s.min / STEP);
  if (isNaN(d) || d.getDay() === 0 || date < today || date > iso(last)) return res.status(400).json({ error: "Тэр өдөр бид амарна." });
  if (!Number.isInteger(start) || start % STEP || start < OPEN || start + n * STEP > CLOSE) return res.status(400).json({ error: "Зөв цаг сонгоно уу." });
  if (date === today && start <= now.getHours() * 60 + now.getMinutes()) return res.status(400).json({ error: "Тэр цаг өнгөрсөн байна." });

  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  try {
    db.transaction(() => {
      const id = db.prepare("INSERT INTO bookings(code,date,start,service,barber,name,phone,email) VALUES(?,?,?,?,?,?,?,?)")
        .run(code, date, start, s.id, br.id, name, phone, email || null).lastInsertRowid;
      const ins = db.prepare("INSERT INTO slots(date,min,barber,booking_id) VALUES(?,?,?,?)");
      for (let i = 0; i < n; i++) ins.run(date, start + i * STEP, br.id, id); // UNIQUE key blocks double-booking
    })();
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "Энэ цагийг дөнгөж сая өөр хүн захиалсан байна. Өөр цаг сонгоно уу." });
    console.error(e); return res.status(500).json({ error: "Алдаа гарлаа. Дахин оролдоно уу." });
  }
  broadcast();
  const when = `${date}, ${fmt(start)} цагт`;
  mail(process.env.OWNER_EMAIL, `Шинэ захиалга: ${name}, ${when}`, `${s.name} · ${br.name}\n${when}\n${name}\n${phone}\n${email}`);
  mail(email, "Таны цаг захиалагдлаа", `Сайн байна уу, ${name}!\n\nТаны захиалга: ${s.name}, ${br.name}, ${when}.\nЗахиалгын код: ${code}\nХарах эсвэл цуцлах: ${req.protocol}://${req.get("host")}/manage.html?code=${code}`);
  res.json({ code });
});

const view = r => r && ({ code: r.code, date: r.date, start: r.start, time: fmt(r.start), service: svc(r.service)?.name, barber: barber(r.barber)?.name, name: r.name });
app.get("/api/booking/:code", (req, res) => {
  const r = db.prepare("SELECT * FROM bookings WHERE code=?").get(clean(req.params.code, 12).toUpperCase());
  r ? res.json(view(r)) : res.status(404).json({ error: "Захиалга олдсонгүй." });
});
app.delete("/api/booking/:code", (req, res) => {
  const r = db.prepare("SELECT * FROM bookings WHERE code=?").get(clean(req.params.code, 12).toUpperCase());
  if (!r) return res.status(404).json({ error: "Захиалга олдсонгүй." });
  db.prepare("DELETE FROM bookings WHERE id=?").run(r.id);
  broadcast();
  mail(process.env.OWNER_EMAIL, `Цуцлагдсан: ${r.name}, ${r.date} ${fmt(r.start)}`, `${r.name} захиалгаа цуцаллаа.`);
  res.json({ ok: true });
});

// ---- Barber API ----
app.post("/api/admin/login", (req, res) => {
  if (!safeEq(String(req.body?.password ?? ""), ADMIN_PASSWORD)) return res.status(401).json({ error: "Нууц үг буруу байна." });
  res.setHeader("Set-Cookie", `admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (_, res) => { res.setHeader("Set-Cookie", "admin=; HttpOnly; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/admin/bookings", needAdmin, (_, res) => {
  const rows = db.prepare("SELECT * FROM bookings WHERE date>=? ORDER BY date,start").all(iso(new Date()));
  res.json(rows.map(r => ({ ...view(r), id: r.id, phone: r.phone, email: r.email, barberId: r.barber })));
});
app.delete("/api/admin/booking/:id", needAdmin, (req, res) => {
  db.prepare("DELETE FROM bookings WHERE id=?").run(Number(req.params.id));
  broadcast(); res.json({ ok: true });
});
app.get("/api/admin/stream", needAdmin, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.listen(PORT, () => console.log(`Barbershop running on http://localhost:${PORT}`));