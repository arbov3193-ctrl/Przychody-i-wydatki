// Family budget — the web app. Plain JS, no build step. Data lives on the server (shared by the family's phones);
// this phone keeps the household code, its own name and a queue of expenses added without internet.
"use strict";

const $ = (s) => document.querySelector(s);
const app = $("#app");
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const fmt = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";
const fmt0 = (n) => Math.round(n || 0).toLocaleString("ru-RU") + " zł";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shiftDay = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shiftMonth = (m, n) => { let [y, mo] = m.split("-").map(Number); mo += n; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, "0")}`; };
// the same as on the server: «BIEDRONKA 1234» and «Biedronka» are one shop
const shopKey = (m) => { const k = String(m || "").toLowerCase().replace(/\s+/g, " ").trim(); return k.replace(/\s*[#№]?\s*\d+$/, "").trim() || k; };
const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return `${MONTHS[mo - 1][0].toUpperCase() + MONTHS[mo - 1].slice(1)} ${y}`; };

let house = LS.get("house", null);         // {id, key, name}
let me = LS.get("me", "");                 // this phone's person
let month = todayIso().slice(0, 7);
let tab = "month";
let S = null;                              // the server state

function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 2200); }

async function api(path, body, method) {
  const r = await fetch("/api/h/" + house.id + path, {
    method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", "X-Key": house.key }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

// expenses added offline wait here and go out at the next chance
async function flushQueue() {
  const q = LS.get("queue", []);
  if (!q.length || !house) return;
  const left = [];
  for (const t of q) { try { await api("/tx", t); } catch (e) { left.push(t); } }
  LS.set("queue", left);
  if (left.length < q.length) await load();
}
window.addEventListener("online", flushQueue);

async function load() {
  try {
    S = await api("/state?month=" + month);
    LS.set("cache:" + month, S);
  } catch (e) {
    S = LS.get("cache:" + month, null);
    if (String(e.message) === "key") return askNewKey();
  }
  render();
}

// the key was changed on the other phone: this one needs the new link
function askNewKey() {
  if ($("#sheet").classList.contains("on") && $("#newCode")) return;   // already asking (the app reloads every minute)
  openSheet(`<b>Ключ бюджета сменили</b>
    <div class="small muted" style="margin-top:6px">Похоже, на другом телефоне выдали новый ключ. Попросите новую ссылку («Ещё» → «Отправить ссылку») и вставьте её сюда.</div>
    <input id="newCode" placeholder="Ссылка или код">
    <button class="btn" onclick="closeSheet();joinBy($('#newCode').value, '')">Подключиться</button>`);
  render();
}

// ------------------------------------------------------------------ numbers of the month

function sums() {
  const by = {};
  for (const t of S.tx) by[t.cat] = (by[t.cat] || 0) + t.amount;
  const spent = S.tx.reduce((a, t) => a + t.amount, 0);
  const planned = Object.values(S.plan.limits || {}).reduce((a, b) => a + b, 0);
  return { by, spent, planned };
}
const catOf = (id) => S.categories.find((c) => c.id === id) || { id, emoji: "📦", name: "Без категории" };

// ------------------------------------------------------------------ screens

function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const badge = $("#badge");
  if (S && S.inbox.length) { badge.style.display = "block"; badge.textContent = S.inbox.length; } else badge.style.display = "none";
  if (!house) return renderStart();
  if (!S) { app.innerHTML = `<div class="empty">Загрузка…</div>`; return; }
  if (tab === "month") renderMonth();
  else if (tab === "inbox") renderInbox();
  else if (tab === "history") renderHistory();
  else if (tab === "settings") renderSettings();
}

function monthHeader() {
  return `<div class="month"><button onclick="go(-1)">‹</button><h1>${monthName(month)}</h1><button onclick="go(1)">›</button></div>`;
}
window.go = (n) => { month = shiftMonth(month, n); S = LS.get("cache:" + month, S && { ...S, tx: [] }); render(); load(); };

function renderMonth() {
  const { by, spent, planned } = sums();
  const budget = S.plan.income || planned;
  const left = budget - spent;
  const isNow = month === todayIso().slice(0, 7);
  const [y, mo] = month.split("-").map(Number);
  const days = new Date(y, mo, 0).getDate();
  const daysLeft = isNow ? days - new Date().getDate() + 1 : 0;
  const pct = budget ? Math.min(100, (spent / budget) * 100) : 0;
  const ring = `<svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--chip)" stroke-width="3.4"/>
    <circle cx="18" cy="18" r="15.9" fill="none" stroke="${left < 0 ? "var(--red)" : pct > 85 ? "var(--yellow)" : "var(--accent)"}" stroke-width="3.4" stroke-linecap="round"
    stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="25"/></svg>`;
  const cats = S.categories.map((c) => {
    const sp = by[c.id] || 0, lim = (S.plan.limits || {})[c.id] || 0;
    if (!sp && !lim) return "";
    const p = lim ? (sp / lim) * 100 : 0;
    return `<div class="cat" onclick="catHistory('${c.id}')"><div class="e">${c.emoji}</div><div class="sp"><div class="row"><span class="n">${esc(c.name)}</span><span class="sp"></span>
      <span class="r">${fmt0(sp)}${lim ? `<span class="muted small"> / ${fmt0(lim)}</span>` : ""}</span></div>
      ${lim ? `<div class="bar ${p > 100 ? "over" : p > 85 ? "warn" : ""}"><i style="width:${Math.min(100, p)}%"></i></div>
      <div class="small muted" style="margin-top:3px">${lim - sp >= 0 ? "осталось " + fmt0(lim - sp) : "перерасход " + fmt0(sp - lim)}</div>` : ""}</div></div>`;
  }).join("");
  const other = Object.keys(by).filter((k) => !S.categories.some((c) => c.id === k));
  const diff = S.prevTotal ? spent - S.prevTotal : 0;
  app.innerHTML = monthHeader() + `
    <div class="card row">${ring}<div class="sp">
      <div class="small muted">Потрачено</div><div class="big">${fmt0(spent)}</div>
      ${budget ? `<div class="${left < 0 ? "" : "muted"}" style="${left < 0 ? "color:var(--red);font-weight:700" : ""}">${left >= 0 ? "осталось " + fmt0(left) : "перерасход " + fmt0(-left)} из ${fmt0(budget)}</div>` : `<div class="muted small">бюджет месяца не задан</div>`}
      ${isNow && budget && left > 0 ? `<div class="small muted" style="margin-top:4px">≈ ${fmt0(left / daysLeft)} в день до конца месяца</div>` : ""}
      ${S.prevTotal ? `<div class="small muted" style="margin-top:4px">прошлый месяц: ${fmt0(S.prevTotal)} (${diff >= 0 ? "+" : "−"}${fmt0(Math.abs(diff))})</div>` : ""}
    </div></div>
    ${S.inbox.length ? `<div class="card row" onclick="setTab('inbox')"><span style="font-size:24px">📥</span><div class="sp"><b>${S.inbox.length} ${plural(S.inbox.length, "трата ждёт", "траты ждут", "трат ждут")} категорию</b>
      <div class="small muted">${fmt0(S.inbox.reduce((a, t) => a + t.amount, 0))} — нажмите, чтобы разобрать</div></div><span>›</span></div>` : ""}
    <button class="btn ghost" onclick="openPlan()">🎯 ${budget ? "Изменить" : "Распределить"} бюджет на ${MONTHS[mo - 1]}</button>
    <h2>По категориям</h2><div class="card">${cats || `<div class="empty">Трат пока нет. Нажмите ＋</div>`}
    ${other.map((k) => `<div class="cat"><div class="e">📦</div><div class="sp n">Без категории</div><div class="r">${fmt0(by[k])}</div></div>`).join("")}</div>
    ${S.members.length > 1 ? `<h2>Кто тратил</h2><div class="card">${S.members.map((w) => `<div class="cat"><div class="e">👤</div><div class="sp n">${esc(w)}</div><div class="r">${fmt0(S.tx.filter((t) => t.who === w).reduce((a, t) => a + t.amount, 0))}</div></div>`).join("")}</div>` : ""}`;
}
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
window.setTab = (t) => { tab = t; render(); };
window.catHistory = (id) => { tab = "history"; histFilter = id; render(); };

function renderInbox() {
  if (!S.inbox.length) {
    app.innerHTML = `<h1>Разобрать</h1>${shotButton()}<div class="empty">📥<br><br>Здесь появляются оплаты Apple Pay с ваших телефонов и суммы со скриншотов уведомлений банка.<br>Нажмите на категорию — трата уйдёт в бюджет.<br><br>Apple Pay: Ещё → «Автоматически из Apple Pay».</div>`;
    return;
  }
  app.innerHTML = `<h1>Разобрать</h1>${shotButton()}<div class="small muted" style="margin-top:4px">Нажмите на категорию — трата уйдёт в бюджет. Магазин запомнится и в следующий раз будет подсказан первым.</div>` +
    S.inbox.map((t) => {
      const sug = S.rules[shopKey(t.merchant)] || S.rules[(t.merchant || "").toLowerCase()];
      const cats = [...S.categories].sort((a, b) => (a.id === sug ? -1 : b.id === sug ? 1 : 0));
      return `<div class="card"><div class="row"><div class="sp"><div class="a big" style="font-size:26px">${fmt(t.amount)}</div>
        <div class="muted small">${esc(t.merchant || "без названия")} · ${esc(t.who || "")} · ${t.date.slice(8, 10)}.${t.date.slice(5, 7)}</div></div>
        <button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="dropInbox('${t.id}')">🗑</button></div>
        <div class="chips">${cats.map((c) => `<button class="${c.id === sug ? "sug" : ""}" onclick="sortInbox('${t.id}','${c.id}')">${c.emoji} ${esc(c.name)}</button>`).join("")}</div></div>`;
    }).join("");
}
window.sortInbox = async (id, cat) => {
  const t = S.inbox.find((x) => x.id === id);
  S.inbox = S.inbox.filter((x) => x.id !== id);
  render();
  try { await api("/tx", { amount: t.amount, cat, note: t.merchant, who: t.who, date: t.date, inboxId: id, merchant: t.merchant, from: "pay" }); toast(catOf(cat).emoji + " " + fmt(t.amount)); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
  load();
};
window.dropInbox = async (id) => {
  if (!confirm("Убрать эту трату? Она не попадёт в бюджет.")) return;
  S.inbox = S.inbox.filter((x) => x.id !== id); render();
  try { await api("/tx/" + id + "?inbox=1", { delete: true }); } catch (e) {}
};

// ------------------------------------------------------------------ amounts from a screenshot of the bank's notifications

const shotButton = () => `<button class="btn ghost" onclick="pickShot()">📷 Суммы со скриншота уведомлений</button>
  <input id="shot" type="file" accept="image/*" multiple style="display:none" onchange="readShots(this.files)">`;
window.pickShot = () => $("#shot").click();

let tess = null;
function loadTesseract() {
  if (tess) return tess;
  tess = new Promise((ok, no) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    sc.onload = () => ok(window.Tesseract); sc.onerror = () => { tess = null; no(new Error("load")); };
    document.head.appendChild(sc);
  });
  return tess;
}

/** «Płatność kartą 45,20 PLN w BIEDRONKA 123», «-120,00 zł Orlen», «Zapłacono 9,99 PLN, ALLEGRO» → [{amount, merchant}] */
function amountsIn(text) {
  const out = [];
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const re = /(?:PLN|zł|zl)?\s*([-–+])?\s*(\d{1,3}(?:[ \u00a0.]\d{3})*(?:[.,]\d{2}))\s*(?:PLN|zł|zl)?/i;
  lines.forEach((l, i) => {
    if (!/(PLN|zł|zl)/i.test(l)) return;
    const m = l.match(re);
    if (!m) return;
    if (m[1] === "+") return;   // «+1 000,00 PLN» in the bank's list is money coming in
    const amount = Number(m[2].replace(/[ \u00a0]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    if (!(amount > 0 && amount < 100000)) return;
    // incoming money (wpływ, przelew przychodzący, зачисление) is not an expense
    if (/wpływ|wpłyn|uznanie|przychodz|otrzyma|зачисл|поступ/i.test(l)) return;
    let merchant = (l.split(m[0])[1] || "").replace(/^[\s,.:;-]*(w|u|at|в|na|do)\s+/i, "").replace(/[,.;]+$/, "").trim();
    if (!merchant || merchant.length < 2) merchant = (lines[i + 1] && !/(PLN|zł)/i.test(lines[i + 1]) ? lines[i + 1] : "").slice(0, 40);
    out.push({ amount, merchant: merchant.slice(0, 40) });
  });
  return out;
}

window.readShots = async (files) => {
  if (!files || !files.length) return;
  openSheet(`<b>Читаю скриншот…</b><div class="small muted" id="ocrState" style="margin-top:8px">Первый раз загружается распознавание (≈5 МБ), потом быстрее.</div>`);
  let found = [];
  try {
    const T = await loadTesseract();
    for (const f of files) {
      const { data } = await T.recognize(f, "pol", { logger: (m) => { const e = $("#ocrState"); if (e && m.progress) e.textContent = `${m.status} ${Math.round(m.progress * 100)}%`; } });
      found = found.concat(amountsIn(data.text));
    }
  } catch (e) {
    openSheet(`<b>Не получилось прочитать</b><div class="small muted" style="margin-top:8px">Нужен интернет для первого запуска. Попробуйте ещё раз.</div><button class="btn ghost" onclick="closeSheet()">OK</button>`);
    return;
  }
  const seen = LS.get("shotSeen", {});
  const day = todayIso();
  found = found.map((t) => ({ ...t, sig: `${t.amount}|${t.merchant.toLowerCase()}`, dup: !!seen[`${t.amount}|${t.merchant.toLowerCase()}`] }));
  shotFound = found;
  if (!found.length) {
    openSheet(`<b>Сумм не нашёл</b><div class="small muted" style="margin-top:8px">На скриншоте должны быть уведомления банка с суммой в zł / PLN.</div><button class="btn ghost" onclick="closeSheet()">OK</button>`);
    return;
  }
  openSheet(`<div class="row"><b class="sp">Найдено: ${found.length}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <div class="small muted" style="margin-top:4px">Отметьте траты — они уйдут в «Разобрать». Уже добавленные раньше сняты.</div>
    ${found.map((t, i) => `<div class="item"><input type="checkbox" id="sh${i}" style="width:24px;height:24px;margin:0" ${t.dup ? "" : "checked"}>
      <div class="sp"><input id="shm${i}" style="margin:0" value="${esc(t.merchant)}" placeholder="Магазин"></div><div class="a">${fmt(t.amount)}</div></div>`).join("")}
    <button class="btn" onclick="addShots()">Добавить в «Разобрать»</button>`);
};
let shotFound = [];
window.addShots = async () => {
  const seen = LS.get("shotSeen", {});
  let n = 0;
  for (let i = 0; i < shotFound.length; i++) {
    if (!$("#sh" + i).checked) continue;
    const t = shotFound[i];
    const merchant = $("#shm" + i).value.trim();
    try { await api("/tx", { amount: t.amount, cat: "", note: merchant, who: me, date: todayIso(), from: "shot" }); n++; seen[t.sig] = Date.now(); } catch (e) {}
  }
  LS.set("shotSeen", seen);
  closeSheet(); toast(`📥 Добавлено: ${n}`); load();
};

let histFilter = null;
let histQuery = "";
function renderHistory() {
  const queue = LS.get("queue", []);
  let html = monthHeader() + `<input id="hq" type="search" placeholder="🔍 Поиск: магазин, заметка, сумма" value="${esc(histQuery)}" oninput="histQuery=this.value;$('#hlist').innerHTML=histList()">`;
  if (histFilter) html += `<div class="chips"><button onclick="histFilter=null;render()">${catOf(histFilter).emoji} ${esc(catOf(histFilter).name)} ✕</button></div>`;
  if (queue.length) html += `<div class="card small">⏳ Ждут интернета: ${queue.length} (${fmt(queue.reduce((a, t) => a + Number(t.amount), 0))})</div>`;
  app.innerHTML = html + `<div id="hlist">${histList()}</div>`;
}
// only the list is redrawn while typing in the search, so the iPhone keyboard stays open
function histList() {
  const q = histQuery.trim().toLowerCase().replace(",", ".");
  const hit = (t) => !q || [t.note, catOf(t.cat).name, t.who, String(t.amount)].some((v) => String(v || "").toLowerCase().includes(q));
  const list = S.tx.filter((t) => (!histFilter || t.cat === histFilter) && hit(t)).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  if (!list.length) return `<div class="empty">${q ? "Ничего не нашлось" : "Трат нет"}</div>`;
  let day = "";
  let html = `<div class="card" style="padding-top:4px">`;
  for (const t of list) {
    if (t.date !== day) { day = t.date; html += `<div class="day">${dayName(day)}</div>`; }
    const c = catOf(t.cat);
    html += `<div class="item" onclick="openEdit('${t.id}')"><div class="e">${c.emoji}</div><div class="sp"><div>${esc(t.note || c.name)}</div>
      <div class="small muted">${esc(c.name)}${t.who ? " · " + esc(t.who) : ""}${t.from === "pay" ? " · Apple Pay" + (t.auto ? " · авто" : "") : t.from === "rec" ? " · 🔁 каждый месяц" : ""}</div></div><div class="a">${fmt(t.amount)}</div></div>`;
  }
  return html + `</div><div class="small muted" style="text-align:center;margin-top:10px">Итого: ${fmt(list.reduce((a, t) => a + t.amount, 0))}</div>
    ${q || histFilter ? "" : `<button class="btn ghost" onclick="exportCsv()">📤 Выгрузить ${MONTHS[Number(month.slice(5)) - 1]} в Excel (CSV)</button>`}`;
}
function dayName(iso) {
  const t = todayIso();
  if (iso === t) return "Сегодня";
  if (iso === shiftDay(t, -1)) return "Вчера";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

function renderSettings() {
  const code = `${house.id}.${house.key}`;
  const join = `${location.origin}/?join=${code}`;
  const hook = `${location.origin}/api/in/${house.id}/${house.key}`;
  app.innerHTML = `<h1>Ещё</h1>
    <h2>Семья</h2><div class="card">
      <div class="row"><b class="sp">${esc(S.name || "Семья")}</b></div>
      <label>Этот телефон — кто?</label>
      <div class="chips">${S.members.map((w) => `<button class="${w === me ? "sug" : ""}" onclick="setMe('${esc(w)}')">👤 ${esc(w)}</button>`).join("")}<button onclick="addMember()">＋ добавить</button></div>
      <label>Подключить второй телефон (жены)</label>
      <div class="small muted">Откройте на её iPhone эту ссылку в Safari или введите код:</div>
      <div class="code">${esc(join)}</div>
      <button class="btn ghost" onclick="share('${esc(join)}')">📤 Отправить ссылку</button>
    </div>
    <h2>Автоматически из Apple Pay</h2><div class="card small">
      Каждая оплата Apple Pay сама попадёт в «Разобрать». Настройте на <b>каждом</b> iPhone (у жены — со своим именем):
      <ol>
        <li>Приложение <b>«Команды»</b> → вкладка <b>«Автоматизация»</b> → <b>＋</b></li>
        <li>Выберите <b>«Транзакция»</b> → ваши карты (Erste) → «Запускать сразу»</li>
        <li>Действие <b>«Получить содержимое URL»</b>:<br>URL — ссылка ниже, Метод — <b>POST</b>, Тело запроса — <b>JSON</b></li>
        <li>Поля JSON: <b>amount</b> → «Сумма» (из транзакции), <b>merchant</b> → «Продавец», <b>who</b> → <b>${esc(me || "ваше имя")}</b></li>
        <li>Готово. Оплатите что-нибудь Apple Pay — трата появится в «Разобрать» или сразу в категории, если магазин знакомый.</li>
        <li>По желанию: ниже добавьте <b>«Получить значение словаря»</b> → ключ <b>text</b> и <b>«Показать уведомление»</b> с этим значением — после оплаты придёт «🛒 Продукты 45,20 zł · осталось 300 zł» (⚠️, если лимит почти кончился).</li>
      </ol>
      <div class="code">${esc(hook)}</div>
      <button class="btn ghost" onclick="copy('${esc(hook)}')">📋 Скопировать ссылку для «Команд»</button>
      <div class="muted" style="margin-top:8px">BLIK, переводы и оплата пластиковой картой сюда не попадают — их добавляйте кнопкой ＋.</div>
    </div>
    <h2>Разбор оплат</h2><div class="card">
      <div class="row" style="gap:12px"><span class="sp"><b>Знакомые магазины — сразу в категорию</b><div class="small muted">Оплата в магазине, который вы уже раскладывали, не ждёт в «Разобрать». Если категория не та — поправьте в «Истории», магазин запомнится заново.</div></span>
        <input type="checkbox" style="width:26px;height:26px;margin:0" ${S.settings?.autoSort !== false ? "checked" : ""} onchange="setAutoSort(this.checked)"></div>
      ${Object.keys(S.rules || {}).length ? `<div class="small muted" style="margin-top:8px">Запомнено магазинов: ${Object.keys(S.rules).length}</div>` : ""}
    </div>
    <h2>Каждый месяц</h2><div class="card">
      <div class="small muted">Аренда, связь, подписки — сами добавятся в бюджет в свой день месяца.</div>
      ${(S.recurring || []).map((r, i) => `<div class="item" onclick="openRec(${i})"><div class="e">${catOf(r.cat).emoji}</div><div class="sp"><div>${esc(r.note || catOf(r.cat).name)}</div>
        <div class="small muted">${r.day}-го числа · ${esc(catOf(r.cat).name)}</div></div><div class="a">${fmt(r.amount)}</div></div>`).join("")}
      <button class="btn ghost" onclick="openRec(-1)">＋ Повторяющаяся трата</button>
    </div>
    <h2>Напоминание «разобрать траты» и виджет</h2><div class="card small">
      Ссылка ниже (открывать методом <b>GET</b>) отвечает, сколько трат ждёт в «Разобрать» и сколько осталось в бюджете.
      <ol>
        <li><b>«Команды»</b> → <b>«Автоматизация»</b> → <b>＋</b> → <b>«Время суток»</b>, например 21:00, ежедневно → «Запускать сразу»</li>
        <li>Действие <b>«Получить содержимое URL»</b> — ссылка ниже, метод GET</li>
        <li><b>«Получить значение словаря»</b> → ключ <b>inbox</b></li>
        <li><b>«Если»</b> значение <b>больше 0</b> → <b>«Показать уведомление»</b>, текст — значение ключа <b>text</b> из того же ответа</li>
      </ol>
      Виджет: отдельная команда с теми же шагами, но значение ключа <b>leftText</b> («Осталось 1 234 zł») → «Показать результат»; добавьте виджет «Команды» на экран Домой.
      <div class="code">${esc(hook)}</div>
      <button class="btn ghost" onclick="copy('${esc(hook)}')">📋 Скопировать ссылку</button>
    </div>
    <h2>Выгрузка</h2><div class="card">
      <button class="btn ghost" style="margin-top:0" onclick="exportCsv()">📤 ${monthName(month)} в Excel (CSV)</button>
      <button class="btn ghost" onclick="exportYear()">📤 Весь ${month.slice(0, 4)} год (CSV)</button>
    </div>
    <h2>Категории</h2><div class="card">
      ${S.categories.map((c, i) => `<div class="cat"><input style="width:56px;text-align:center;margin:0" value="${esc(c.emoji)}" onchange="catEdit(${i},'emoji',this.value)">
        <input style="margin:0" value="${esc(c.name)}" onchange="catEdit(${i},'name',this.value)"><button class="btn ghost" style="width:auto;margin:0;padding:10px" onclick="catDel(${i})">✕</button></div>`).join("")}
      <button class="btn ghost" onclick="catAdd()">＋ Категория</button>
    </div>
    <h2>Установка</h2><div class="card small">На iPhone: Safari → кнопка «Поделиться» → <b>«На экран Домой»</b>. Бюджет откроется как обычное приложение.</div>
    <h2>Безопасность</h2><div class="card small">
      Ключ бюджета есть в ссылке для жены и в ссылке «Команд». Если ссылка попала к чужим людям — выдайте новый ключ: старые ссылки перестанут работать.
      <button class="btn ghost" onclick="rekey()">🔑 Выдать новый ключ</button>
    </div>
    <button class="btn red" style="margin-top:24px" onclick="leave()">Отключить этот телефон</button>`;
}
window.setAutoSort = async (v) => {
  try { const r = await api("/settings", { autoSort: v }); S.settings = r.settings; toast(v ? "Знакомые магазины — сразу в категорию" : "Все оплаты — в «Разобрать»"); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); render(); }
};
window.rekey = async () => {
  if (!confirm("Выдать новый ключ?\n\nПосле этого нужно:\n• отправить жене новую ссылку;\n• заменить ссылку в «Командах» на обоих телефонах.\n\nДо этого оплаты Apple Pay не будут приходить.")) return;
  try {
    const r = await api("/rekey", {});
    house = { ...house, key: r.key }; LS.set("house", house);
    toast("🔑 Новый ключ выдан"); render();
  } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.share = async (u) => { try { await navigator.share({ title: "Семейный бюджет", url: u }); } catch (e) { copy(u); } };
window.copy = async (t) => { try { await navigator.clipboard.writeText(t); toast("Скопировано"); } catch (e) { prompt("Скопируйте:", t); } };
window.setMe = (w) => { me = w; LS.set("me", w); render(); };
window.addMember = async () => {
  const w = (prompt("Имя (например, Жена):") || "").trim();
  if (!w) return;
  const r = await api("/member", { who: w }); S.members = r.members; if (!me) setMe(w); render();
};
window.catEdit = async (i, f, v) => { S.categories[i][f] = v; await api("/categories", { categories: S.categories }); toast("Сохранено"); };
window.catDel = async (i) => { if (!confirm(`Удалить «${S.categories[i].name}»? Траты останутся.`)) return; S.categories.splice(i, 1); await api("/categories", { categories: S.categories }); render(); };
window.catAdd = async () => {
  const n = (prompt("Название категории:") || "").trim(); if (!n) return;
  S.categories.push({ id: Math.random().toString(36).slice(2, 8), emoji: "🏷", name: n }); await api("/categories", { categories: S.categories }); render();
};
window.leave = () => { if (!confirm("Отключить телефон от семейного бюджета? Данные останутся на сервере.")) return; localStorage.clear(); house = null; S = null; render(); };

// ------------------------------------------------------------------ monthly expenses

window.openRec = (i) => {
  const r = i >= 0 ? S.recurring[i] : { amount: "", cat: "", note: "", day: new Date().getDate() };
  openSheet(`<div class="row"><b class="sp">${i >= 0 ? "Каждый месяц" : "Новая повторяющаяся трата"}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <label>Сумма, zł</label><input id="rAmount" inputmode="decimal" value="${r.amount ? String(r.amount).replace(".", ",") : ""}" placeholder="0">
    <label>Название</label><input id="rNote" value="${esc(r.note)}" placeholder="Аренда, телефон, Netflix…">
    <label>Какого числа</label><input id="rDay" inputmode="numeric" value="${r.day}">
    <label>Категория</label><div class="cats">${S.categories.map((c) => `<button class="${r.cat === c.id ? "on" : ""}" data-id="${c.id}" onclick="document.querySelectorAll('#sheet .cats button').forEach(b=>b.classList.remove('on'));this.classList.add('on')"><span>${c.emoji}</span>${esc(c.name)}</button>`).join("")}</div>
    <button class="btn" onclick="saveRec(${i})">Сохранить</button>
    ${i >= 0 ? `<button class="btn red" onclick="delRec(${i})">Больше не повторять</button><div class="small muted" style="margin-top:6px">Уже добавленные траты останутся в истории.</div>` : ""}`);
};
window.saveRec = async (i) => {
  const amount = Number(String($("#rAmount").value).replace(",", "."));
  const cat = $("#sheet .cats button.on")?.dataset.id;
  const day = Math.min(31, Math.max(1, parseInt($("#rDay").value, 10) || 1));
  if (!(amount > 0)) return toast("Введите сумму");
  if (!cat) return toast("Выберите категорию");
  const list = [...(S.recurring || [])];
  const r = { ...(i >= 0 ? list[i] : {}), amount, cat, note: $("#rNote").value.trim(), day };
  if (i < 0) {
    // a new one: if its day has already passed this month, ask whether it is to be counted this month too
    const cur = todayIso().slice(0, 7);
    r.from = day <= new Date().getDate() && !confirm(`${day}-е число уже было. Добавить «${r.note || catOf(cat).name}» и в этот месяц?\n\nОтмена — начать со следующего месяца.`) ? shiftMonth(cur, 1) : cur;
    list.push(r);
  } else list[i] = r;
  try { await api("/recurring", { recurring: list }); closeSheet(); toast("🔁 Сохранено"); load(); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.delRec = async (i) => {
  if (!confirm("Больше не добавлять эту трату каждый месяц?")) return;
  const list = S.recurring.filter((_, j) => j !== i);
  try { await api("/recurring", { recurring: list }); closeSheet(); load(); } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};

// ------------------------------------------------------------------ export for Excel / Numbers

// «;» and a decimal comma — what Excel expects with Polish / Russian settings; the BOM keeps the Cyrillic readable
function csvOf(list) {
  const q = (v) => { const t = String(v ?? ""); return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [["Дата", "Категория", "Заметка", "Кто", "Сумма, zł"]];
  for (const t of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([`${t.date.slice(8, 10)}.${t.date.slice(5, 7)}.${t.date.slice(0, 4)}`, catOf(t.cat).name, t.note, t.who, t.amount.toFixed(2).replace(".", ",")]);
  }
  rows.push(["", "", "", "Итого", list.reduce((a, t) => a + t.amount, 0).toFixed(2).replace(".", ",")]);
  return "\ufeff" + rows.map((r) => r.map(q).join(";")).join("\r\n");
}
async function saveFile(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const file = new File([blob], name, { type: "text/csv" });
  // on the iPhone «Поделиться» lets the file go to «Файлы», Numbers, Excel, mail or a messenger
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
window.exportCsv = () => {
  if (!S.tx.length) return toast("В этом месяце трат нет");
  saveFile(`budget-${month}.csv`, csvOf(S.tx));
};
window.exportYear = async () => {
  const y = month.slice(0, 4);
  const last = y === todayIso().slice(0, 4) ? Number(todayIso().slice(5, 7)) : 12;
  toast("Собираю год…");
  let all = [];
  try {
    for (let m = 1; m <= last; m++) all = all.concat((await api(`/state?month=${y}-${String(m).padStart(2, "0")}`)).tx);
  } catch (e) { return toast("Нужен интернет"); }
  if (!all.length) return toast("За год трат нет");
  saveFile(`budget-${y}.csv`, csvOf(all));
};

// ------------------------------------------------------------------ the first start

function renderStart() {
  $("#tabs").style.display = "none";
  app.innerHTML = `<div style="text-align:center;margin-top:40px"><div style="font-size:64px">💰</div><h1>Семейный бюджет</h1>
    <div class="muted" style="margin-top:8px">Траты за месяц, лимиты по категориям и оплаты Apple Pay — на двух телефонах сразу.</div></div>
    <div class="card"><b>Создать бюджет</b>
      <label>Ваше имя</label><input id="who" placeholder="Артур" value="${esc(me)}">
      <button class="btn" onclick="create()">Создать</button></div>
    <div class="card"><b>Подключиться к бюджету семьи</b>
      <label>Код или ссылка от мужа / жены</label><input id="code" placeholder="xxxxxxxxxx.xxxxxxxxxxxxxxxx">
      <label>Ваше имя</label><input id="who2" placeholder="Жена">
      <button class="btn ghost" onclick="joinBy($('#code').value, $('#who2').value)">Подключиться</button></div>`;
}
window.create = async () => {
  const who = $("#who").value.trim();
  if (!who) return toast("Введите имя");
  const r = await (await fetch("/api/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Семья", who }) })).json();
  if (!r.id) return toast("Не получилось, попробуйте ещё раз");
  house = { id: r.id, key: r.key }; LS.set("house", house); setMe(who);
  $("#tabs").style.display = ""; await load(); toast("Бюджет создан");
};
window.joinBy = async (raw, who) => {
  const m = String(raw || "").match(/([a-z0-9]{10})\.([a-z0-9]{16})/);
  if (!m) return toast("Код не похож на код бюджета");
  house = { id: m[1], key: m[2] }; LS.set("house", house);
  $("#tabs").style.display = "";
  try { await api("/state"); } catch (e) { house = null; LS.set("house", null); renderStart(); return toast("Код не подходит"); }
  if (who && who.trim()) { await api("/member", { who: who.trim() }); setMe(who.trim()); }
  history.replaceState(null, "", "/");
  await load(); toast("Подключено");
};

// ------------------------------------------------------------------ sheets: add, edit, plan

function openSheet(html) { const s = $("#sheet"); s.innerHTML = `<div class="in">${html}</div>`; s.classList.add("on"); }
function closeSheet() { $("#sheet").classList.remove("on"); }
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
window.closeSheet = closeSheet;

let draft = null;
function openAdd() {
  draft = { amount: "", cat: "", note: "", date: todayIso(), who: me };
  drawAdd();
}
function drawAdd() {
  const d = draft;
  openSheet(`<div class="row"><b class="sp">Новая трата</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <div class="amount">${d.amount ? esc(d.amount.replace(".", ",")) : "0"} zł</div>
    <div class="pad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"].map((k) => `<button onclick="key('${k}')">${k}</button>`).join("")}</div>
    <div class="cats">${S.categories.map((c) => `<button class="${d.cat === c.id ? "on" : ""}" onclick="pickCat('${c.id}')"><span>${c.emoji}</span>${esc(c.name)}</button>`).join("")}</div>
    <input id="note" placeholder="Заметка (необязательно)" value="${esc(d.note)}" oninput="draft.note=this.value">
    <div class="chips">${[["Сегодня", todayIso()], ["Вчера", shiftDay(todayIso(), -1)]].map(([n, v]) => `<button class="${d.date === v ? "sug" : ""}" onclick="draft.date='${v}';drawAdd()">${n}</button>`).join("")}
      <input type="date" style="width:auto;margin:0;padding:6px 10px" value="${d.date}" onchange="draft.date=this.value"></div>
    ${S.members.length > 1 ? `<div class="chips">${S.members.map((w) => `<button class="${d.who === w ? "sug" : ""}" onclick="draft.who='${esc(w)}';drawAdd()">👤 ${esc(w)}</button>`).join("")}</div>` : ""}
    <button class="btn" onclick="saveAdd()">Сохранить${d.cat ? "" : " в «Разобрать»"}</button>`);
}
window.key = (k) => {
  let a = draft.amount;
  if (k === "⌫") a = a.slice(0, -1);
  else if (k === ",") { if (!a.includes(".")) a = (a || "0") + "."; }
  else if (!/\.\d\d$/.test(a) && a.length < 8) a = a === "0" ? k : a + k;
  draft.amount = a; drawAdd();
};
window.pickCat = (c) => { draft.cat = draft.cat === c ? "" : c; drawAdd(); };
window.saveAdd = async () => {
  if (!Number(draft.amount)) return toast("Введите сумму");
  const t = { ...draft, amount: Number(draft.amount) };
  closeSheet();
  try { await api("/tx", t); toast((draft.cat ? catOf(draft.cat).emoji + " " : "📥 ") + fmt(t.amount)); }
  catch (e) { const q = LS.get("queue", []); q.push(t); LS.set("queue", q); toast("Нет интернета — сохраню позже"); }
  load();
};

window.openEdit = (id) => {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  openSheet(`<div class="row"><b class="sp">Трата</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <label>Сумма, zł</label><input id="eAmount" inputmode="decimal" value="${String(t.amount).replace(".", ",")}">
    <label>Заметка</label><input id="eNote" value="${esc(t.note)}">
    <label>Дата</label><input id="eDate" type="date" value="${t.date}">
    <label>Категория</label><div class="cats">${S.categories.map((c) => `<button class="${t.cat === c.id ? "on" : ""}" onclick="document.querySelectorAll('#sheet .cats button').forEach(b=>b.classList.remove('on'));this.classList.add('on');this.dataset.pick=1" data-id="${c.id}"><span>${c.emoji}</span>${esc(c.name)}</button>`).join("")}</div>
    <button class="btn" onclick="saveEdit('${id}')">Сохранить</button>
    <button class="btn red" onclick="delTx('${id}')">Удалить</button>`);
};
window.saveEdit = async (id) => {
  const cat = $("#sheet .cats button.on")?.dataset.id;
  await api(`/tx/${id}?month=${month}`, { amount: $("#eAmount").value, note: $("#eNote").value, date: $("#eDate").value, cat });
  closeSheet(); load();
};
window.delTx = async (id) => { if (!confirm("Удалить трату?")) return; await api(`/tx/${id}?month=${month}`, { delete: true }); closeSheet(); load(); };

window.openPlan = () => {
  const lim = S.plan.limits || {};
  const { by } = sums();
  openSheet(`<div class="row"><b class="sp">Бюджет на ${monthName(month).toLowerCase()}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <label>Сколько есть на месяц (доход), zł</label><input id="pIncome" inputmode="decimal" value="${S.plan.income || ""}" oninput="planLeft()">
    <div id="pLeft" class="small" style="margin-top:6px"></div>
    <h2>Лимиты по категориям</h2>
    ${S.categories.map((c) => `<div class="cat"><div class="e">${c.emoji}</div><div class="sp"><div class="n">${esc(c.name)}</div>
      <div class="small muted">${by[c.id] ? "потрачено " + fmt0(by[c.id]) : ""}</div></div>
      <input class="lim" data-id="${c.id}" inputmode="decimal" style="width:110px;margin:0;text-align:right" placeholder="0" value="${lim[c.id] || ""}" oninput="planLeft()"></div>`).join("")}
    <button class="btn" onclick="savePlan()">Сохранить бюджет</button>
    <div class="small muted" style="margin-top:8px">Следующий месяц начнётся с этих же лимитов — их можно поменять.</div>`);
  planLeft();
};
window.planLeft = () => {
  const inc = Number(String($("#pIncome").value).replace(",", ".")) || 0;
  const sum = [...document.querySelectorAll(".lim")].reduce((a, e) => a + (Number(String(e.value).replace(",", ".")) || 0), 0);
  const left = inc - sum;
  $("#pLeft").innerHTML = inc ? (left >= 0 ? `Распределено ${fmt0(sum)} · <b>свободно ${fmt0(left)}</b>` : `<span style="color:var(--red)">Распределено больше дохода на ${fmt0(-left)}</span>`) : `Распределено ${fmt0(sum)}`;
};
window.savePlan = async () => {
  const limits = {};
  document.querySelectorAll(".lim").forEach((e) => { if (e.value) limits[e.dataset.id] = e.value; });
  await api("/plan", { month, income: $("#pIncome").value, limits });
  closeSheet(); toast("Бюджет сохранён"); load();
};

// ------------------------------------------------------------------ start

document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.tab === "add") { if (S) openAdd(); return; }
  if (b.dataset.tab === "history") histFilter = null;
  tab = b.dataset.tab; render();
}));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
const joinParam = new URLSearchParams(location.search).get("join");
if (joinParam && !house) { renderStart(); $("#code").value = joinParam; }
else if (house) { load().then(flushQueue); setInterval(() => { if (document.visibilityState === "visible") load(); }, 60000); }
else render();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && house) load(); });
