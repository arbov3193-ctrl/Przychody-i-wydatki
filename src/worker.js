// Family budget: the API behind the web app. One Durable Object per household holds everything:
// categories, the month plans, the expenses (one list per month) and the «inbox» of payments that came in
// from Apple Pay (iPhone «Shortcuts» automation) and wait for a category.
//
//   POST /api/create                 {name, who}          → {id, key}       a new household
//   GET  /api/h/<id>/state?month=…   (X-Key)              → categories, plan, expenses, inbox, members
//   POST /api/h/<id>/tx              (X-Key) {amount, cat, note, who, date}  an expense (no cat → inbox)
//   POST /api/h/<id>/tx/<txId>       (X-Key) {cat?, amount?, note?, date?, delete?}
//   POST /api/h/<id>/categories      (X-Key) {categories}
//   POST /api/h/<id>/plan            (X-Key) {month, income, limits}
//   POST /api/h/<id>/member          (X-Key) {who}
//   POST /api/in/<id>/<key>          {amount, merchant, who}   from the iPhone Shortcut (key in the path)
import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/api/create" && request.method === "POST") {
        const id = rand(10);
        const key = rand(16);
        const body = await request.json().catch(() => ({}));
        const r = await house(env, id).fetch(new Request("https://internal/init", { method: "POST", body: JSON.stringify({ key, name: body.name, who: body.who }) }));
        return r.ok ? json({ id, key }) : json({ error: "init" }, 500);
      }
      const m = url.pathname.match(/^\/api\/(h|in)\/([a-z0-9]{10})(?:\/([a-z0-9]{16}))?(\/.*)?$/);
      if (!m) return json({ error: "not found" }, 404);
      const [, kind, id, pathKey, rest] = m;
      const key = kind === "in" ? pathKey : request.headers.get("X-Key");
      const sub = kind === "in" ? "/inbox" : rest || "/";
      return cors(await house(env, id).fetch(new Request("https://internal" + sub + url.search, {
        method: request.method, headers: { "X-Key": key || "" }, body: request.method === "GET" ? undefined : await request.text(),
      })));
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

const house = (env, id) => env.HOUSE.get(env.HOUSE.idFromName(id));

export class House extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const s = this.ctx.storage;
    const body = request.method === "GET" ? {} : await request.json().catch(() => ({}));
    if (url.pathname === "/init") {
      if (await s.get("key")) return json({ error: "exists" }, 409);
      await s.put("key", body.key);
      await s.put("name", String(body.name || "Семья").slice(0, 40));
      await s.put("members", body.who ? [String(body.who).slice(0, 20)] : []);
      await s.put("categories", DEFAULT_CATEGORIES);
      return json({ ok: true });
    }
    const key = await s.get("key");
    if (!key || request.headers.get("X-Key") !== key) return json({ error: "key" }, 403);

    if (url.pathname === "/state") {
      const month = monthOf(url.searchParams.get("month"));
      return json({
        name: await s.get("name"),
        members: (await s.get("members")) || [],
        categories: (await s.get("categories")) || DEFAULT_CATEGORIES,
        plan: (await s.get(`plan:${month}`)) || (await s.get(`plan:${prevMonth(month)}`)) || { income: 0, limits: {} },
        planIsOwn: !!(await s.get(`plan:${month}`)),
        tx: (await s.get(`tx:${month}`)) || [],
        prevTotal: total((await s.get(`tx:${prevMonth(month)}`)) || []),
        inbox: (await s.get("inbox")) || [],
        rules: (await s.get("rules")) || {},
        month,
      });
    }
    if (url.pathname === "/inbox") {
      // from the Shortcut: «45,20 zł», «PLN 45.20», 45.2 — and the shop's name
      const amount = parseAmount(body.amount);
      if (!amount) return json({ error: "amount" }, 400);
      const item = { id: rand(8), amount, merchant: String(body.merchant || "").slice(0, 60), who: String(body.who || "").slice(0, 20), date: today(), time: Date.now() };
      const inbox = (await s.get("inbox")) || [];
      inbox.unshift(item);
      await s.put("inbox", inbox.slice(0, 300));
      return json({ ok: true, amount });
    }
    if (url.pathname === "/tx" && request.method === "POST") {
      const amount = parseAmount(body.amount);
      if (!amount) return json({ error: "amount" }, 400);
      const tx = { id: rand(8), amount, cat: String(body.cat || ""), note: String(body.note || "").slice(0, 80), who: String(body.who || "").slice(0, 20),
        date: /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today(), time: Date.now(), from: body.from ? String(body.from).slice(0, 8) : undefined };
      // an inbox payment sorted into a category: it leaves the inbox; the shop is remembered for the next time
      if (body.inboxId) {
        const inbox = ((await s.get("inbox")) || []).filter((x) => x.id !== body.inboxId);
        await s.put("inbox", inbox);
        if (body.merchant && tx.cat) {
          const rules = (await s.get("rules")) || {};
          rules[String(body.merchant).toLowerCase()] = tx.cat;
          await s.put("rules", rules);
        }
      }
      if (!tx.cat) {
        const inbox = (await s.get("inbox")) || [];
        inbox.unshift({ id: tx.id, amount, merchant: tx.note, who: tx.who, date: tx.date, time: tx.time });
        await s.put("inbox", inbox);
        return json({ ok: true, inbox: true });
      }
      const k = `tx:${tx.date.slice(0, 7)}`;
      const list = (await s.get(k)) || [];
      list.unshift(tx);
      await s.put(k, list);
      return json({ ok: true, tx });
    }
    const edit = url.pathname.match(/^\/tx\/([a-z0-9]{8})$/);
    if (edit) {
      const month = monthOf(url.searchParams.get("month"));
      if (url.searchParams.get("inbox")) {
        const inbox = ((await s.get("inbox")) || []).filter((x) => x.id !== edit[1]);
        await s.put("inbox", inbox);
        return json({ ok: true });
      }
      const k = `tx:${month}`;
      let list = (await s.get(k)) || [];
      const i = list.findIndex((t) => t.id === edit[1]);
      if (i < 0) return json({ error: "no tx" }, 404);
      if (body.delete) list = list.filter((t) => t.id !== edit[1]);
      else {
        const t = list[i];
        if (body.cat !== undefined) t.cat = String(body.cat);
        if (body.note !== undefined) t.note = String(body.note).slice(0, 80);
        if (body.amount !== undefined && parseAmount(body.amount)) t.amount = parseAmount(body.amount);
        if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) && body.date.slice(0, 7) !== month) {
          // moved to another month
          list = list.filter((x) => x.id !== t.id);
          t.date = body.date;
          const k2 = `tx:${t.date.slice(0, 7)}`;
          const other = (await s.get(k2)) || [];
          other.unshift(t);
          await s.put(k2, other);
        } else if (body.date) t.date = body.date;
      }
      await s.put(k, list);
      return json({ ok: true });
    }
    if (url.pathname === "/categories") {
      const cats = (Array.isArray(body.categories) ? body.categories : []).slice(0, 40)
        .map((c) => ({ id: String(c.id || rand(6)).slice(0, 12), emoji: String(c.emoji || "📦").slice(0, 4), name: String(c.name || "").slice(0, 24) }))
        .filter((c) => c.name);
      if (!cats.length) return json({ error: "empty" }, 400);
      await s.put("categories", cats);
      return json({ ok: true });
    }
    if (url.pathname === "/plan") {
      const month = monthOf(body.month);
      const limits = {};
      for (const [k, v] of Object.entries(body.limits || {})) { const n = parseAmount(v); if (n) limits[String(k).slice(0, 12)] = n; }
      await s.put(`plan:${month}`, { income: parseAmount(body.income) || 0, limits });
      return json({ ok: true });
    }
    if (url.pathname === "/member") {
      const who = String(body.who || "").trim().slice(0, 20);
      if (!who) return json({ error: "who" }, 400);
      const members = (await s.get("members")) || [];
      if (!members.includes(who)) members.push(who);
      await s.put("members", members.slice(0, 10));
      return json({ ok: true, members });
    }
    return json({ error: "not found" }, 404);
  }
}

const DEFAULT_CATEGORIES = [
  { id: "food", emoji: "🛒", name: "Продукты" },
  { id: "home", emoji: "🏠", name: "Жильё" },
  { id: "bills", emoji: "💡", name: "Счета и связь" },
  { id: "car", emoji: "⛽", name: "Топливо и авто" },
  { id: "transport", emoji: "🚌", name: "Транспорт" },
  { id: "cafe", emoji: "🍽", name: "Кафе и доставка" },
  { id: "kids", emoji: "🧸", name: "Дети" },
  { id: "health", emoji: "💊", name: "Здоровье" },
  { id: "clothes", emoji: "👕", name: "Одежда" },
  { id: "fun", emoji: "🎉", name: "Развлечения" },
  { id: "gifts", emoji: "🎁", name: "Подарки" },
  { id: "other", emoji: "📦", name: "Прочее" },
];

function parseAmount(v) {
  if (typeof v === "number") return v > 0 && v < 1e7 ? Math.round(v * 100) / 100 : 0;
  const m = String(v || "").replace(/\s/g, "").match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  return n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : 0;
}
const total = (list) => Math.round(list.reduce((a, t) => a + t.amount, 0) * 100) / 100;
function today() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const monthOf = (m) => (/^\d{4}-\d{2}$/.test(m || "") ? m : today().slice(0, 7));
function prevMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
function rand(n) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
}
const cors = (r) => {
  const h = new Headers(r.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Key");
  return new Response(r.body, { status: r.status, headers: h });
};
const json = (o, status = 200) => cors(new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
