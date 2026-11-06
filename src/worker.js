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
//   POST /api/h/<id>/settings        (X-Key) {autoSort}   known shops go straight into their category
//   POST /api/h/<id>/rekey           (X-Key)              → {key}   a new key; the old links and Shortcuts stop working
//   POST /api/h/<id>/recurring       (X-Key) {recurring: [{id?, amount, cat, note, day, from?}]}  monthly expenses (rent, phone…)
//   POST /api/in/<id>/<key>          {amount, merchant, who}   from the iPhone Shortcut (key in the path)
//                                    → {ok, amount, cat?, text, alert}   text: «🛒 Продукты 45,20 zł · осталось 300 zł» for a notification
//   GET  /api/in/<id>/<key>          → {inbox, inboxSum, spent, budget, left, text}   for a reminder / widget Shortcut
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
      await applyRecurring(s, month);
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
        recurring: (await s.get("recurring")) || [],
        settings: { autoSort: true, ...((await s.get("settings")) || {}) },
        month,
      });
    }
    if (url.pathname === "/inbox" && request.method === "GET") {
      // for the Shortcut that reminds to sort the payments (and can show «left this month» in a widget)
      const month = today().slice(0, 7);
      await applyRecurring(s, month);
      const inbox = (await s.get("inbox")) || [];
      const tx = (await s.get(`tx:${month}`)) || [];
      const plan = (await s.get(`plan:${month}`)) || (await s.get(`plan:${prevMonth(month)}`)) || { income: 0, limits: {} };
      const budget = plan.income || Object.values(plan.limits || {}).reduce((a, b) => a + b, 0);
      const spent = total(tx);
      const left = Math.round((budget - spent) * 100) / 100;
      const n = inbox.length;
      const text = n ? `📥 Разобрать: ${n} ${plural(n, "трата", "траты", "трат")} на ${zl(total(inbox))}` : "";
      return json({ inbox: n, inboxSum: total(inbox), spent, budget, left, text, leftText: budget ? (left >= 0 ? `Осталось ${zl(left)}` : `Перерасход ${zl(-left)}`) : `Потрачено ${zl(spent)}` });
    }
    if (url.pathname === "/inbox") {
      // from the Shortcut: «45,20 zł», «PLN 45.20», 45.2 — and the shop's name
      const amount = parseAmount(body.amount);
      if (!amount) return json({ error: "amount" }, 400);
      const item = { id: rand(8), amount, merchant: String(body.merchant || "").trim().slice(0, 60), who: String(body.who || "").slice(0, 20), date: today(), time: Date.now() };
      // a shop sorted before goes straight into its category (unless switched off in «Ещё»)
      const settings = { autoSort: true, ...((await s.get("settings")) || {}) };
      const cats = (await s.get("categories")) || DEFAULT_CATEGORIES;
      const cat = settings.autoSort && item.merchant ? ((await s.get("rules")) || {})[shopKey(item.merchant)] : "";
      if (cat && cats.some((c) => c.id === cat)) {
        const k = `tx:${item.date.slice(0, 7)}`;
        const list = (await s.get(k)) || [];
        list.unshift({ id: item.id, amount, cat, note: item.merchant, who: item.who, date: item.date, time: item.time, from: "pay", auto: true });
        await s.put(k, list);
        return json({ ok: true, amount, cat, ...(await catNews(s, cats, cat, item.date.slice(0, 7), amount)) });
      }
      const inbox = (await s.get("inbox")) || [];
      inbox.unshift(item);
      await s.put("inbox", inbox.slice(0, 300));
      return json({ ok: true, amount, text: `📥 ${zl(amount)}${item.merchant ? " · " + item.merchant : ""} — в «Разобрать»`, alert: false });
    }
    if (url.pathname === "/tx" && request.method === "POST") {
      const amount = parseAmount(body.amount);
      if (!amount) return json({ error: "amount" }, 400);
      const tx = { id: rand(8), amount, cat: String(body.cat || ""), note: String(body.note || "").slice(0, 80), who: String(body.who || "").slice(0, 20),
        date: /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today(), time: Date.now(), from: body.from ? String(body.from).slice(0, 8) : undefined };
      // an inbox payment sorted into a category: it leaves the inbox; the shop is remembered for the next time
      if (body.remember && body.merchant && tx.cat) {
        // sorted by hand on the screenshot sheet: the shop goes there next time too
        const rules = (await s.get("rules")) || {};
        rules[shopKey(body.merchant)] = tx.cat;
        await s.put("rules", rules);
      }
      if (body.inboxId) {
        const inbox = ((await s.get("inbox")) || []).filter((x) => x.id !== body.inboxId);
        await s.put("inbox", inbox);
        if (body.merchant && tx.cat) {
          const rules = (await s.get("rules")) || {};
          rules[shopKey(body.merchant)] = tx.cat;
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
        if (body.cat !== undefined && body.cat !== t.cat) {
          t.cat = String(body.cat);
          // a payment moved to another category: next time the shop goes there
          if (t.from === "pay" && t.note && t.cat) {
            const rules = (await s.get("rules")) || {};
            rules[shopKey(t.note)] = t.cat;
            await s.put("rules", rules);
          }
          delete t.auto;
        }
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
    if (url.pathname === "/settings") {
      const settings = { autoSort: true, ...((await s.get("settings")) || {}) };
      if (typeof body.autoSort === "boolean") settings.autoSort = body.autoSort;
      await s.put("settings", settings);
      return json({ ok: true, settings });
    }
    if (url.pathname === "/rekey" && request.method === "POST") {
      const k = rand(16);
      await s.put("key", k);
      return json({ ok: true, key: k });
    }
    if (url.pathname === "/recurring") {
      const cur = today().slice(0, 7);
      const list = (Array.isArray(body.recurring) ? body.recurring : []).slice(0, 40).map((r) => ({
        id: /^[a-z0-9]{8}$/.test(r.id || "") ? r.id : rand(8),
        amount: parseAmount(r.amount), cat: String(r.cat || "").slice(0, 12), note: String(r.note || "").slice(0, 80),
        day: Math.min(31, Math.max(1, Math.round(Number(r.day)) || 1)),
        from: /^\d{4}-\d{2}$/.test(r.from || "") ? r.from : cur,
      })).filter((r) => r.amount && r.cat);
      await s.put("recurring", list);
      return json({ ok: true, recurring: list });
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

// «BIEDRONKA 1234», «Biedronka  #12» and «biedronka» are one shop for the rules
function shopKey(m) {
  // «PEPCO 110806 POZNAN» and «PEPCO 111057 POZNAN», «BIEDRONKA 1234» and «Biedronka»: the numbers of the shop are left out
  const k = String(m || "").toLowerCase().replace(/…|\.{2,}/g, " ").replace(/\s+/g, " ").trim();
  return k.replace(/(^|\s)[#№*]?\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim() || k;
}

// what a Shortcut can show after a payment went into a category: the category's limit, or the month's budget
async function catNews(s, cats, cat, month, amount) {
  const c = cats.find((x) => x.id === cat) || { emoji: "📦", name: "" };
  const tx = (await s.get(`tx:${month}`)) || [];
  const plan = (await s.get(`plan:${month}`)) || (await s.get(`plan:${prevMonth(month)}`)) || { income: 0, limits: {} };
  const lim = (plan.limits || {})[cat] || 0;
  let tail = "", alert = false;
  if (lim) {
    const sp = total(tx.filter((t) => t.cat === cat));
    alert = sp / lim > 0.85;
    tail = sp <= lim ? ` · осталось ${zl(Math.round((lim - sp) * 100) / 100)} из ${zl(lim)}` : ` · ⚠️ перерасход ${zl(Math.round((sp - lim) * 100) / 100)}`;
    if (alert && sp <= lim) tail = " · ⚠️" + tail.slice(2);
  } else {
    const budget = plan.income || Object.values(plan.limits || {}).reduce((a, b) => a + b, 0);
    if (budget) { const left = Math.round((budget - total(tx)) * 100) / 100; alert = left < 0; tail = left >= 0 ? ` · в месяце осталось ${zl(left)}` : ` · ⚠️ перерасход месяца ${zl(-left)}`; }
  }
  return { text: `${c.emoji} ${c.name} ${zl(amount)}${tail}`, alert };
}

// Monthly expenses (rent, phone, subscriptions) are written into the month on their day, once:
// `rec:YYYY-MM` remembers which ones are done, so one deleted by hand does not come back.
async function applyRecurring(s, month) {
  const list = (await s.get("recurring")) || [];
  if (!list.length) return;
  const now = today();
  const cur = now.slice(0, 7);
  if (month > cur) return;
  const done = (await s.get(`rec:${month}`)) || [];
  const [y, mo] = month.split("-").map(Number);
  const days = new Date(y, mo, 0).getDate();
  const add = list.filter((r) => !done.includes(r.id) && r.from <= month && (month < cur || Math.min(r.day, days) <= Number(now.slice(8, 10))));
  if (!add.length) return;
  const k = `tx:${month}`;
  const tx = (await s.get(k)) || [];
  for (const r of add) {
    tx.unshift({ id: rand(8), amount: r.amount, cat: r.cat, note: r.note, who: "", date: `${month}-${String(Math.min(r.day, days)).padStart(2, "0")}`, time: Date.now(), from: "rec", rec: r.id });
    done.push(r.id);
  }
  await s.put(k, tx);
  await s.put(`rec:${month}`, done);
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
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const zl = (n) => `${n.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} zł`;
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
