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
const shopKey = (m) => { const k = String(m || "").toLowerCase().replace(/…|\.{2,}/g, " ").replace(/\s+/g, " ").trim(); return k.replace(/(^|\s)[#№*]?\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim() || k; };
const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return `${MONTHS[mo - 1][0].toUpperCase() + MONTHS[mo - 1].slice(1)} ${y}`; };

let house = LS.get("house", null);         // {id, key, name}
let me = LS.get("me", "");                 // this phone's person
let month = todayIso().slice(0, 7);
let tab = "month";
let S = null;                              // what the screens show
let SF = null;                             // the server state as it came
// The full phone looks like the wife's unless «secret» is on: 5 quick taps on the month's name; it goes off as soon as
// the app leaves the screen. Then the 🙈 categories, their expenses and sums, and the real balance are shown.
let secret = false;
function publicOf(F) {
  const hid = new Set(F.categories.filter((c) => c.hidden).map((c) => c.id));
  // «нам должны» from this phone and the incomes when they come back are the wife's view too: not shown
  F = { ...F, debts: (F.debts || []).filter((d) => !(d.dir === "them" && !d.pub)), inc: (F.inc || []).filter((t) => !t.priv) };
  if (!hid.size) return { ...F, balance: F.balanceShared || F.balance };
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !hid.has(k)));
  return { ...F, categories: F.categories.filter((c) => !c.hidden), tx: F.tx.filter((t) => !hid.has(t.cat)),
    plan: { ...F.plan, limits: strip(F.plan.limits), keep: strip(F.plan.keep) }, notes: strip(F.notes), recurring: (F.recurring || []).filter((r) => !hid.has(r.cat)),
    rules: Object.fromEntries(Object.entries(F.rules || {}).filter(([, c]) => !hid.has(c))), balance: F.balanceShared || F.balance,
    receipts: (F.receipts || []).filter((r) => !hid.has(r.cat)), warranties: (F.warranties || []).filter((r) => !hid.has(r.cat)) };
}
function setState(F) { SF = F; S = !F || F.role === "partner" || secret ? F : publicOf(F); }
const everyday = () => S && SF && S !== SF;   // lists sent to the server lack the hidden items — the server keeps them

function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 2200); }

async function api(path, body, method) {
  if (body && everyday()) body = { ...body, keepHidden: true };
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
    setState(await api("/state?month=" + month));
    // a name cut at 20 letters by the old server: take the full one once it is known
    if (me.length === 20) { const f = S.members.find((m) => m.length > 20 && m.startsWith(me)); if (f) { me = f; LS.set("me", f); } }
    LS.set("cache:" + month, SF);
  } catch (e) {
    setState(LS.get("cache:" + month, null));
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
// «debt» is not one of the family's categories: debts given back have their own line and take nothing from the limits
const DEBT_CAT = { id: "debt", emoji: "💸", name: "Долги" };
const catOf = (id) => S.categories.find((c) => c.id === id) || (id === "debt" ? DEBT_CAT : { id, emoji: "📦", name: "Без категории" });

// ------------------------------------------------------------------ screens

function render() { renderScreen(); fillReceipts(); }
function renderScreen() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const badge = $("#badge");
  if (S && S.inbox.length) { badge.style.display = "block"; badge.textContent = S.inbox.length; } else badge.style.display = "none";
  if (!house) return renderStart();
  if (!S) { app.innerHTML = `<div class="empty">Загрузка…</div>`; return; }
  if (tab === "month") renderMonth();
  else if (tab === "inbox") renderInbox();
  else if (tab === "income") renderIncome();
  else if (tab === "receipts") renderReceipts();
  else if (tab === "history") renderHistory();
  else if (tab === "settings") renderSettings();
}

function monthHeader() {
  return `<div class="month"><button onclick="go(-1)">‹</button><h1 onclick="secretTap()" class="${secret ? "sec" : ""}">${monthName(month)}</h1><button onclick="go(1)">›</button></div>`;
}
let taps = [];
window.secretTap = () => {
  if (!SF || SF.role === "partner") return;
  const now = Date.now();
  taps = taps.filter((t) => now - t < 2500).concat(now);
  if (taps.length < 5) return;
  taps = []; secret = !secret; setState(SF); render();
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && secret) { secret = false; setState(SF); render(); } });
window.go = (n) => { month = shiftMonth(month, n); setState(LS.get("cache:" + month, SF && { ...SF, tx: [] })); render(); load(); };

// ------------------------------------------------------------------ balance: what the family has, what has to be given back

const B = () => S.balance || { value: 0, need: 0, owed: 0, free: 0, start: null };
// «Бюджет» — how much is still needed: what is left of each category's limit this month plus the payments and debts to give;
// «Необходимо» = Бюджет − Баланс: how much is missing (or, when the balance is bigger, how much is left over)
function budgetNeed() {
  const { by } = sums();
  const lim = S.plan.limits || {};
  const cats = S.categories.map((c) => ({ c, lim: lim[c.id] || 0, sp: by[c.id] || 0, rest: Math.max(0, (lim[c.id] || 0) - (by[c.id] || 0)) }));
  const debts = (S.debts || []).filter((d) => d.dir === "we");
  const total = cats.reduce((a, x) => a + x.rest, 0) + debts.reduce((a, d) => a + d.amount, 0);
  return { cats, debts, total };
}
function balanceCard() {
  const b = B(), bud = budgetNeed();
  // what we are owed counts as money that will come: it lowers «Необходимо» (it is not on the account yet, so not in «Баланс»)
  const need = bud.total - b.value - (b.owed || 0);
  const inc = (S.inc || []).reduce((a, t) => a + t.amount, 0), out = sums().spent;
  const mName = MONTHS[Number(month.slice(5)) - 1];
  return `<div class="card">
    <div class="bal">
      <div onclick="openBalance()"><div class="small muted">Баланс ✎ · есть</div><div class="big ${b.value < 0 ? "neg" : ""}">${fmt0(b.value)}</div>${b.owed ? `<div class="owed" onclick="event.stopPropagation();document.getElementById('owed').scrollIntoView({behavior:'smooth'})">(${fmt0(b.owed)} должны вернуть)</div>` : ""}</div>
      <div onclick="document.getElementById('budget').scrollIntoView({behavior:'smooth'})" style="text-align:right"><div class="small muted">Бюджет · надо</div><div class="big">${fmt0(bud.total)}</div></div>
    </div>
    <div class="needline ${need > 0 ? "short" : "ok"}">${need > 0 ? `Необходимо: <b>${fmt0(need)}</b>` : `Хватает · останется <b>${fmt0(-need)}</b>`}${b.owed ? `<div class="small" style="opacity:.8;margin-top:2px">с учётом ${fmt0(b.owed)}, которые должны вернуть</div>` : ""}</div>
    <div class="row small muted" style="margin-top:6px"><span class="sp">${mName[0].toUpperCase() + mName.slice(1)}: <span class="pos">+${fmt0(inc)}</span> доходы · −${fmt0(out)} расходы</span></div>
    ${b.start ? "" : `<div class="small muted" style="margin-top:6px">Нажмите «Баланс», чтобы вписать, сколько сейчас на счёте, — дальше он будет считаться сам.</div>`}
  </div>`;
}
const noteBtn = (key, has) => `<button class="mini note ${has ? "has" : ""}" onclick="event.stopPropagation();openNote('${key}')" aria-label="Заметка">📝</button>`;
function needCard() {
  const bud = budgetNeed(), notes = S.notes || {}, all = S.debts || [];
  const catRow = (x) => `<div class="cat" onclick="openPlan()"><div class="e">${x.c.emoji}</div><div class="sp"><div class="n">${esc(x.c.name)}${x.c.hidden ? " 🙈" : ""}</div>
    ${notes[x.c.id] ? `<div class="small note-t">${esc(notes[x.c.id])}</div>` : ""}</div>
    <div class="r">${!x.lim ? `<span class="muted small">—</span>` : x.sp > x.lim
      ? `<span class="neg">−${fmt0(x.sp - x.lim)}</span><div class="small neg" style="font-weight:600;white-space:nowrap">перерасход</div>`
      : `${fmt0(x.rest)}<div class="small muted" style="font-weight:400">из ${fmt0(x.lim)}</div>`}</div>${noteBtn(x.c.id, notes[x.c.id])}</div>`;
  const debtRow = (d) => { const i = all.indexOf(d); return `<div class="cat"><div class="e">${d.dir === "we" ? "💸" : "🤝"}</div><div class="sp" onclick="openDebt(${i})"><div class="n">${esc(d.name)}${secret && d.dir === "them" && !d.pub ? " 🙈" : ""}</div>
    ${d.note ? `<div class="small note-t">${esc(d.note)}</div>` : `<div class="small muted">${d.dir === "we" ? "нужно отдать" : "должны нам"}</div>`}</div>
    <div class="r">${fmt0(d.amount)}</div>${noteBtn("d:" + i, d.note)}<button class="mini" onclick="settleDebt(${i})">${d.dir === "we" ? "Отдали" : "Вернули"}</button></div>`; };
  return `<h2 id="budget">Бюджет — сколько надо</h2><div class="card">
    ${bud.cats.map(catRow).join("")}${bud.debts.map(debtRow).join("")}
    <div class="row" style="gap:8px"><button class="btn ghost sp" onclick="openPlan()">🎯 Суммы</button><button class="btn ghost sp" onclick="openDebt(-1,'we')">＋ Отдать</button></div>
    <div class="small muted" style="margin-top:8px">Справа — сколько ещё надо по категории в этом месяце (лимит минус потраченное). Нажмите на категорию, чтобы поменять сумму, 📝 — заметка.</div></div>
    ${all.some((d) => d.dir === "them") ? `<h2 id="owed">Нам должны</h2><div class="card">${all.filter((d) => d.dir === "them").map(debtRow).join("")}</div>` : ""}
    ${S.role === "partner" || secret ? `<button class="btn ghost" onclick="openDebt(-1,'them')">🤝 ＋ Нам должны</button>` : ""}`;
}
window.openNote = (key) => {
  const isDebt = key.startsWith("d:"), d = isDebt ? S.debts[Number(key.slice(2))] : null;
  const title = isDebt ? d.name : catOf(key).emoji + " " + catOf(key).name;
  const text = isDebt ? d.note || "" : (S.notes || {})[key] || "";
  openSheet(`<div class="row"><b class="sp">📝 ${esc(title)}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <textarea id="noteText" rows="4" maxlength="300" placeholder="Например: купить зимнюю резину, отдать до 15-го…">${esc(text)}</textarea>
    <button class="btn" onclick="saveNote('${key}')">Сохранить</button>
    ${text ? `<button class="btn red" onclick="$('#noteText').value='';saveNote('${key}')">Удалить заметку</button>` : ""}`);
  setTimeout(() => $("#noteText").focus(), 50);
};
window.saveNote = async (key) => {
  const text = $("#noteText").value.trim();
  try {
    if (key.startsWith("d:")) { const list = S.debts.map((x) => ({ ...x })); list[Number(key.slice(2))].note = text; await putDebts(list); }
    else { const r = await api("/note", { key, text }); S.notes = r.notes; render(); }
    closeSheet(); toast(text ? "📝 Сохранено" : "Заметка удалена");
  } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.openBalance = () => {
  const b = B();
  openSheet(`<div class="row"><b class="sp">Сколько сейчас на счёте</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <div class="small muted" style="margin-top:6px">Впишите баланс из приложения банка. Дальше он считается сам: доходы прибавляются, траты вычитаются. Если разойдётся с банком — впишите заново.</div>
    <label>Баланс, zł</label><input id="bAmount" inputmode="decimal" value="${String(b.value).replace(".", ",")}">
    <button class="btn" onclick="saveBalance()">Сохранить</button>
    ${b.start ? `<div class="small muted" style="margin-top:8px">Последний раз вписан ${b.start.date.slice(8, 10)}.${b.start.date.slice(5, 7)}: ${fmt(b.start.amount)}</div>` : ""}`);
};
window.saveBalance = async () => {
  const v = String($("#bAmount").value).replace(/\s/g, "").replace(",", ".");
  if (v === "" || !Number.isFinite(Number(v))) return toast("Введите сумму");
  try { const r = await api("/balance", { amount: v }); S.balance = r.balance; closeSheet(); render(); toast("Баланс сохранён"); } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.openDebt = (i, dir) => {
  const d = i >= 0 ? S.debts[i] : { name: "", amount: "", dir: dir || "we" };
  openSheet(`<div class="row"><b class="sp">${i >= 0 ? "Изменить" : d.dir === "we" ? "Нужно отдать" : "Нам должны"}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <div class="chips"><button id="dWe" class="${d.dir === "we" ? "sug" : ""}" onclick="this.classList.add('sug');$('#dThem').classList.remove('sug')">💸 Нужно отдать</button>
      <button id="dThem" class="${d.dir === "them" ? "sug" : ""}" ${S.role === "partner" || secret || d.dir === "them" ? "" : `style="display:none"`} onclick="this.classList.add('sug');$('#dWe').classList.remove('sug')">🤝 Нам должны</button></div>
    <label>Что / кому</label><input id="dName" value="${esc(d.name)}" placeholder="Долг Ивану, налог, ремонт машины…">
    <label>Сумма, zł</label><input id="dAmount" inputmode="decimal" value="${d.amount ? String(d.amount).replace(".", ",") : ""}" placeholder="0">
    <button class="btn" onclick="saveDebt(${i})">Сохранить</button>
    ${i >= 0 ? `<button class="btn red" onclick="delDebt(${i})">Удалить без записи</button>` : ""}`);
};
async function putDebts(list) { await api("/debts", { debts: list }); await load(); }
window.saveDebt = async (i) => {
  const name = $("#dName").value.trim(), amount = Number(String($("#dAmount").value).replace(/\s/g, "").replace(",", "."));
  if (!name) return toast("Напишите, что это"); if (!(amount > 0)) return toast("Введите сумму");
  const list = [...(S.debts || [])], x = { ...(i >= 0 ? list[i] : {}), name, amount, dir: $("#dThem").classList.contains("sug") ? "them" : "we" };
  if (i >= 0) list[i] = x; else list.push(x);
  try { await putDebts(list); closeSheet(); } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.delDebt = async (i) => { if (!confirm("Удалить? В траты и доходы ничего не запишется.")) return; try { await putDebts(S.debts.filter((_, j) => j !== i)); closeSheet(); } catch (e) { toast("Нет связи"); } };
// given back → an expense (it leaves the account); got back → an income
window.settleDebt = async (i) => {
  const x = S.debts[i];
  if (!confirm(x.dir === "we" ? `Отдали «${x.name}» ${fmt(x.amount)}?\nЗапишется тратой «💸 Долги» (лимиты категорий не трогает) и уйдёт из бюджета.` : `Вернули «${x.name}» ${fmt(x.amount)}?\nЗапишется доходом и прибавится к балансу.`)) return;
  try {
    if (x.dir === "we") await api("/tx", { amount: x.amount, cat: "debt", from: "debt", note: "Долг: " + x.name, who: me, date: todayIso() });
    else await api("/income", { amount: x.amount, cat: "debt", note: x.name, who: me, date: todayIso(), priv: !x.pub });
    await putDebts(S.debts.filter((_, j) => j !== i));
    toast(x.dir === "we" ? "💸 Записано" : "🤝 Записано"); load();
  } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};

// ------------------------------------------------------------------ incomes

const INCOME_CATS = [
  { id: "salary", emoji: "💼", name: "Зарплата" }, { id: "benefit", emoji: "👶", name: "800+ / пособия" }, { id: "side", emoji: "🛠", name: "Подработка" },
  { id: "gift", emoji: "🎁", name: "Подарок" }, { id: "debt", emoji: "🤝", name: "Вернули долг" }, { id: "refund", emoji: "↩️", name: "Возврат" }, { id: "other", emoji: "💰", name: "Другое" },
];
const incCat = (id) => INCOME_CATS.find((c) => c.id === id) || INCOME_CATS[INCOME_CATS.length - 1];
function renderIncome() {
  const list = [...(S.inc || [])].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const sum = list.reduce((a, t) => a + t.amount, 0);
  const by = {};
  for (const t of list) by[t.cat] = (by[t.cat] || 0) + t.amount;
  let html = monthHeader() + `<div class="card"><div class="small muted">Доходы за ${MONTHS[Number(month.slice(5)) - 1]}</div><div class="big pos">+${fmt0(sum)}</div>
    ${S.plan.income ? `<div class="small muted">план: ${fmt0(S.plan.income)}</div>` : ""}
    ${Object.keys(by).length > 1 ? `<div class="small muted" style="margin-top:6px">${Object.entries(by).map(([k, v]) => `${incCat(k).emoji} ${fmt0(v)}`).join(" · ")}</div>` : ""}</div>
    <button class="btn" onclick="openIncome()">＋ Доход</button>`;
  if (!list.length) return (app.innerHTML = html + `<div class="empty">💼<br><br>Зарплата, 800+, подработка, возврат долга — всё, что пришло на счёт. Доходы прибавляются к балансу.</div>`);
  let day = "";
  html += `<div class="card" style="padding-top:4px">`;
  for (const t of list) {
    if (t.date !== day) { day = t.date; html += `<div class="day">${dayName(day)}</div>`; }
    const c = incCat(t.cat);
    html += `<div class="item" onclick="openIncome('${t.id}')"><div class="e">${c.emoji}</div><div class="sp"><div>${esc(t.note || c.name)}</div>
      <div class="small muted">${esc(c.name)}${t.who ? " · " + esc(t.who) : ""}</div></div><div class="a pos">+${fmt(t.amount)}</div></div>`;
  }
  app.innerHTML = html + `</div>`;
}
window.openIncome = (id) => {
  const t = id ? S.inc.find((x) => x.id === id) : { amount: "", cat: "salary", note: "", date: todayIso(), who: me };
  if (!t) return;
  openSheet(`<div class="row"><b class="sp">${id ? "Доход" : "Новый доход"}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <label>Сумма, zł</label><input id="iAmount" inputmode="decimal" value="${t.amount ? String(t.amount).replace(".", ",") : ""}" placeholder="0">
    <div class="cats">${INCOME_CATS.map((c) => `<button class="${t.cat === c.id ? "on" : ""}" data-id="${c.id}" onclick="document.querySelectorAll('#sheet .cats button').forEach(b=>b.classList.remove('on'));this.classList.add('on')"><span>${c.emoji}</span>${c.name}</button>`).join("")}</div>
    <input id="iNote" placeholder="Откуда (необязательно)" value="${esc(t.note)}">
    <label>Дата</label><input id="iDate" type="date" value="${t.date}">
    ${S.members.length > 1 ? `<div class="chips">${S.members.map((w) => `<button class="${t.who === w ? "sug" : ""}" data-who="${esc(w)}" onclick="document.querySelectorAll('#sheet .chips button').forEach(b=>b.classList.remove('sug'));this.classList.add('sug')">👤 ${esc(w)}</button>`).join("")}</div>` : ""}
    <button class="btn" onclick="saveIncome('${id || ""}')">Сохранить</button>
    ${id ? `<button class="btn red" onclick="delIncome('${id}')">Удалить</button>` : ""}`);
  if (!id) setTimeout(() => $("#iAmount").focus(), 50);
};
window.saveIncome = async (id) => {
  const amount = Number(String($("#iAmount").value).replace(/\s/g, "").replace(",", "."));
  if (!(amount > 0)) return toast("Введите сумму");
  const body = { amount, cat: $("#sheet .cats button.on")?.dataset.id || "other", note: $("#iNote").value.trim(), date: $("#iDate").value || todayIso(),
    who: $("#sheet .chips button.sug")?.dataset.who || me };
  try { await api(id ? `/income/${id}?month=${month}` : "/income", body); closeSheet(); toast("💼 +" + fmt(amount)); load(); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.delIncome = async (id) => { if (!confirm("Удалить доход?")) return; try { await api(`/income/${id}?month=${month}`, { delete: true }); closeSheet(); load(); } catch (e) { toast("Нет связи"); } };

function renderMonth() {
  const { by, spent, planned } = sums();
  const budget = S.plan.income || planned;
  const left = budget - spent;
  const [, mo] = month.split("-").map(Number);
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
  app.innerHTML = monthHeader() + balanceCard() + needCard() + `
    ${(S.warranties || []).filter((r) => r.wty >= todayIso() && r.wty <= shiftDay(todayIso(), 30)).map((r) => `<div class="card row" onclick="setTab('receipts');openReceipt('${r.id}')"><span style="font-size:24px">🛡</span>
      <div class="sp"><b>Гарантия «${esc(r.wtyName || r.note || "покупка")}» кончается</b><div class="small muted">${wtyLeft(r.wty)} — чек в «Чеки»</div></div><span>›</span></div>`).join("")}
    ${S.inbox.length ? `<div class="card row" onclick="setTab('inbox')"><span style="font-size:24px">📥</span><div class="sp"><b>${S.inbox.length} ${plural(S.inbox.length, "трата ждёт", "траты ждут", "трат ждут")} категорию</b>
      <div class="small muted">${fmt0(S.inbox.reduce((a, t) => a + t.amount, 0))} — нажмите, чтобы разобрать</div></div><span>›</span></div>` : ""}
    <h2>По категориям</h2><div class="card">${cats || `<div class="empty">Трат пока нет. Нажмите ＋</div>`}
    ${other.map((k) => `<div class="cat" onclick="catHistory('${k}')"><div class="e">${catOf(k).emoji}</div><div class="sp n">${esc(catOf(k).name)}</div><div class="r">${fmt0(by[k])}</div></div>`).join("")}</div>
    ${S.members.length > 1 ? `<h2>Кто тратил</h2><div class="card">${S.members.map((w) => `<div class="cat"><div class="e">👤</div><div class="sp n">${esc(w)}</div><div class="r">${fmt0(S.tx.filter((t) => t.who === w).reduce((a, t) => a + t.amount, 0))}</div></div>`).join("")}</div>` : ""}`;
}
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
window.setTab = (t) => { tab = t; render(); };
window.catHistory = (id) => { tab = "history"; histFilter = id; render(); };

function renderInbox() {
  if (!S.inbox.length) {
    app.innerHTML = `<h1>Разобрать</h1>${shotButton()}<div class="empty">📥<br><br>Здесь появляются оплаты Apple Pay с ваших телефонов и траты со скриншотов банка без категории.<br>Нажмите на категорию — трата уйдёт в бюджет.<br><br>Apple Pay: Ещё → «Автоматически из Apple Pay».</div>`;
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
  try { await api("/tx", { amount: t.amount, cat, note: t.merchant, who: t.who, date: t.date, inboxId: id, merchant: t.merchant, from: "pay", rc: t.rc }); toast(catOf(cat).emoji + " " + fmt(t.amount)); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
  load();
};
window.dropInbox = async (id) => {
  if (!confirm("Убрать эту трату? Она не попадёт в бюджет.")) return;
  S.inbox = S.inbox.filter((x) => x.id !== id); render();
  try { await api("/tx/" + id + "?inbox=1", { delete: true }); } catch (e) {}
};

// ------------------------------------------------------------------ amounts from a screenshot of the bank's notifications

const shotButton = () => `<button class="btn ghost" onclick="pickShot()">📷 Траты со скриншотов</button>
  <div class="small muted" style="text-align:center;margin-top:-4px">«Historia transakcji» в приложении Erste или уведомления банка — можно несколько скриншотов сразу</div>
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

const PL_MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const AMT = String.raw`(\d+(?:[ \u00a0]\d{3})*[.,]\d{2})`;
const num = (s) => Number(s.replace(/[ \u00a0]/g, "").replace(",", "."));
// the icon in front of a row comes out of the recognition as «cf», «s]», «=.», «()» — dropped
const clean = (s) => s.replace(/[…]+|\.{2,}/g, " ").replace(/^(?:\S{1,2}\s+)+(?=\S{3,})/, "").replace(/^[^\p{L}\d]+/u, "").replace(/\s+/g, " ").trim();

// Erste's own categories → ours (only those that exist in this budget are used)
const BANK_CATS = [
  [/spożywcz|supermarket|żywność/i, "food"], [/odzież|obuwie/i, "clothes"], [/telefon|internet|\btv\b|prąd|gaz|woda|media|rachunk/i, "bills"],
  [/czynsz|mieszkan|remont|wyposaż/i, "home"], [/prezent/i, "gifts"], [/bilet|komunikac|transport|taksówk|taxi/i, "transport"],
  [/paliw|parking|samoch|auto/i, "car"], [/restaurac|kawiar|jedzenie|fast ?food|bary?\b/i, "cafe"], [/zdrow|aptek|lekarz|medyc/i, "health"],
  [/rozryw|kino|sport|hobby|kultur|podróż/i, "fun"], [/dziec|zabawk|przedszk|żłob/i, "kids"],
];
const bankCat = (s) => { const f = BANK_CATS.find(([re]) => re.test(s || "")); return f && S.categories.some((c) => c.id === f[1]) ? f[1] : ""; };

/**
 * Text read from screenshots → [{amount, merchant, date, bank}].
 * Erste's «Historia transakcji»: «8 października, czwartek», then rows «JMP S.A. BIEDRONKA 493 -100,25 PLN» with
 * «Spożywcze i chemia gospodarcza 5 568,31 PLN» under them (the bank's category and the balance). Expenses have «−»,
 * money coming in has no sign. Notifications: «Płatność kartą 45,20 PLN w BIEDRONKA», «Zapłacono 9,99 zł u ALLEGRO».
 */
function amountsIn(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const signed = new RegExp(String.raw`([-−–+])\s?` + AMT + String.raw`\s*(?:PLN|zł|zl)`, "i");
  const out = [];
  out.incomes = [];
  let skipped = 0;
  if (lines.some((l) => /^[-−–]/.test((l.match(signed) || [""])[0]))) {
    // the bank's list of transactions: a row (name, amount) and under it a line with the balance
    const amtRe = new RegExp(AMT + String.raw`\s*(?:PLN|zł|zl)`, "i");
    const now = todayIso();
    let date = now;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = l.match(new RegExp(String.raw`^(\d{1,2})\s+(` + PL_MONTHS.join("|") + ")", "i"));
      if (d) {
        const mo = PL_MONTHS.indexOf(d[2].toLowerCase()) + 1;
        let y = Number(now.slice(0, 4));
        if (mo > Number(now.slice(5, 7))) y--;   // a December row looked at in January
        date = `${y}-${String(mo).padStart(2, "0")}-${String(d[1]).padStart(2, "0")}`;
        continue;
      }
      if (!amtRe.test(l)) continue;
      const next = lines[i + 1] || "";
      const hasBalance = amtRe.test(next) && !signed.test(next);
      if (hasBalance) i++;   // the balance line is not a transaction
      const m = l.match(signed);
      if (!m || m[1] === "+") {
        // money coming in has no «−»: offered as an income (the row's own amount, not the balance under it)
        if (hasBalance) {
          const a = l.match(amtRe), amount = a ? num(a[1]) : 0;
          if (amount > 0 && amount < 1000000) out.incomes.push({ amount, merchant: clean(l.slice(0, a.index)).slice(0, 40), date, bank: clean(next.split(new RegExp(AMT))[0]) });
          else skipped++;
        }
        continue;
      }
      const amount = num(m[2]);
      if (!(amount > 0 && amount < 100000)) continue;
      out.push({ amount, merchant: clean(l.slice(0, m.index)).slice(0, 40), date, bank: hasBalance ? clean(next.split(new RegExp(AMT))[0]) : "" });
    }
    out.skipped = skipped;
    return out;
  }
  // notifications
  const re = new RegExp(String.raw`(?:PLN|zł|zl)?\s*([-−–+])?\s*` + AMT + String.raw`\s*(?:PLN|zł|zl)?`, "i");
  lines.forEach((l, i) => {
    if (!/(PLN|zł|zl)/i.test(l)) return;
    const m = l.match(re);
    if (!m || m[1] === "+") return;
    const amount = num(m[2]);
    if (!(amount > 0 && amount < 100000)) return;
    // incoming money (wpływ, przelew przychodzący, зачисление) is not an expense
    if (/wpływ|wpłyn|wpłata|uznanie|przychodz|otrzyma|зачисл|поступ/i.test(l)) {
      const from = (l.split(m[0])[1] || "").replace(/^[\s,.:;-]*(od|z|from|от)\s+/i, "").replace(/[,.;]+$/, "").trim();
      out.incomes.push({ amount, merchant: from.slice(0, 40), date: todayIso(), bank: "" });
      return;
    }
    let merchant = (l.split(m[0])[1] || "").replace(/^[\s,.:;-]*(w|u|at|в|na|do)\s+/i, "").replace(/[,.;]+$/, "").trim();
    if (!merchant || merchant.length < 2) merchant = (lines[i + 1] && !/(PLN|zł)/i.test(lines[i + 1]) ? lines[i + 1] : "").slice(0, 40);
    out.push({ amount, merchant: merchant.slice(0, 40), date: todayIso(), bank: "" });
  });
  out.skipped = skipped;
  return out;
}

window.readShots = async (files) => {
  if (!files || !files.length) return;
  openSheet(`<b>Читаю скриншот…</b><div class="small muted" id="ocrState" style="margin-top:8px">Первый раз загружается распознавание (≈5 МБ), потом быстрее.</div>`);
  let found = [], incomes = [], skipped = 0;
  try {
    const T = await loadTesseract();
    for (const f of files) {
      const { data } = await T.recognize(f, "pol", { logger: (m) => { const e = $("#ocrState"); if (e && m.progress) e.textContent = `${m.status} ${Math.round(m.progress * 100)}%`; } });
      const got = amountsIn(data.text);
      skipped += got.skipped || 0;
      found = found.concat(got);
      incomes = incomes.concat(got.incomes || []);
    }
  } catch (e) {
    openSheet(`<b>Не получилось прочитать</b><div class="small muted" style="margin-top:8px">Нужен интернет для первого запуска. Попробуйте ещё раз.</div><button class="btn ghost" onclick="closeSheet()">OK</button>`);
    return;
  }
  // screenshots that overlap (scrolled a little) give the same row twice
  const uniq = new Map();
  for (const t of found) uniq.set(`${t.date}|${t.amount}|${shopKey(t.merchant)}`, t);
  found = [...uniq.values()].sort((a, b) => b.date.localeCompare(a.date));
  const uniqI = new Map();
  for (const t of incomes) uniqI.set(`${t.date}|${t.amount}|${shopKey(t.merchant)}`, t);
  incomes = [...uniqI.values()].sort((a, b) => b.date.localeCompare(a.date));
  if (!found.length && !incomes.length) {
    openSheet(`<b>Ничего не нашёл</b><div class="small muted" style="margin-top:8px">Подойдёт скриншот «Historia transakcji» из приложения Erste или уведомлений банка с суммой в zł / PLN.</div><button class="btn ghost" onclick="closeSheet()">OK</button>`);
    return;
  }
  // what is already in the budget (an Apple Pay payment the same day with the same amount) is not ticked
  const have = new Set(), haveI = new Set();
  const add = (list) => (list || []).forEach((t) => have.add(`${t.date}|${t.amount}`));
  const addI = (list) => (list || []).forEach((t) => haveI.add(`${t.date}|${t.amount}`));
  add(S.tx); add(S.inbox); addI(S.inc);
  for (const m of new Set([...found, ...incomes].map((t) => t.date.slice(0, 7)))) {
    if (m === S.month) continue;
    try { const o = await api("/state?month=" + m); add(o.tx); addI(o.inc); } catch (e) {}
  }
  const seen = LS.get("shotSeen", {});
  found = found.map((t) => {
    const sig = `${t.date}|${t.amount}|${shopKey(t.merchant)}`;
    return { ...t, sig, dup: !!seen[sig] || have.has(`${t.date}|${t.amount}`), cat: S.rules[shopKey(t.merchant)] || bankCat(t.bank) };
  });
  shotFound = found;
  // money coming in: already recorded incomes and cash put in at a cash machine (own money, not an income) are not ticked
  incomes = incomes.map((t) => {
    const sig = `in|${t.date}|${t.amount}|${shopKey(t.merchant)}`;
    const own = /wpłatomat|wpłata we|wpłata gotówk|przelew własny|własny/i.test(t.bank + " " + t.merchant);
    return { ...t, sig, own, dup: !!seen[sig] || haveI.has(`${t.date}|${t.amount}`), cat: incomeCatOf(t) };
  });
  shotIncomes = incomes;
  const dups = found.filter((t) => t.dup).length;
  openSheet(`<div class="row"><b class="sp">Найдено: ${found.length} ${plural(found.length, "трата", "траты", "трат")}${incomes.length ? `, ${incomes.length} ${plural(incomes.length, "поступление", "поступления", "поступлений")}` : ""}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    ${found.length ? `<h2>Траты</h2><div class="small muted">С категорией — сразу в бюджет, без неё — в «Разобрать».${dups ? ` Уже записанные (${dups}) сняты.` : ""}</div>` : ""}
    ${found.map((t, i) => `<div class="shot"><input type="checkbox" id="sh${i}" ${t.dup ? "" : "checked"}>
      <div class="sp"><div class="row" style="gap:8px"><input id="shm${i}" class="sp" value="${esc(t.merchant)}" placeholder="Магазин"><b>${fmt(t.amount)}</b></div>
        <div class="row" style="gap:8px;margin-top:4px"><span class="small muted sp">${t.date.slice(8, 10)}.${t.date.slice(5, 7)}${t.bank ? " · " + esc(t.bank) : ""}</span>
        <select id="shc${i}">${[`<option value="">📥 Разобрать</option>`, ...S.categories.map((c) => `<option value="${c.id}" ${c.id === t.cat ? "selected" : ""}>${c.emoji} ${esc(c.name)}</option>`)].join("")}</select></div></div></div>`).join("")}
    ${incomes.length ? `<h2>Поступления → «Доходы»</h2><div class="small muted">Уже записанные и пополнения через банкомат (свои же деньги) сняты.</div>
    ${incomes.map((t, i) => `<div class="shot"><input type="checkbox" id="si${i}" ${t.dup || t.own ? "" : "checked"}>
      <div class="sp"><div class="row" style="gap:8px"><input id="sim${i}" class="sp" value="${esc(t.merchant)}" placeholder="Откуда"><b class="pos">+${fmt(t.amount)}</b></div>
        <div class="row" style="gap:8px;margin-top:4px"><span class="small muted sp">${t.date.slice(8, 10)}.${t.date.slice(5, 7)}${t.bank ? " · " + esc(t.bank) : ""}</span>
        <select id="sic${i}">${INCOME_CATS.map((c) => `<option value="${c.id}" ${c.id === t.cat ? "selected" : ""}>${c.emoji} ${c.name}</option>`).join("")}</select></div></div></div>`).join("")}` : ""}
    <button class="btn" onclick="addShots()">Добавить отмеченные</button>`);
};
// the bank's words → our kinds of income
function incomeCatOf(t) {
  const w = t.bank + " " + t.merchant;
  if (/wynagrodz|pensj|premi|płac/i.test(w)) return "salary";
  if (/zus|800|świadcz|zasił|rodzin|socjal/i.test(w)) return "benefit";
  if (/zwrot|refund|return/i.test(w)) return "refund";
  return "other";
}
let shotFound = [], shotIncomes = [];
window.addShots = async () => {
  const seen = LS.get("shotSeen", {});
  let n = 0, toInbox = 0;
  for (let i = 0; i < shotFound.length; i++) {
    if (!$("#sh" + i).checked) continue;
    const t = shotFound[i];
    const merchant = $("#shm" + i).value.trim();
    const cat = $("#shc" + i).value;
    try {
      await api("/tx", { amount: t.amount, cat, note: merchant, who: me, date: t.date, from: "shot", merchant: cat ? merchant : "", remember: !!cat });
      n++; if (!cat) toInbox++; seen[t.sig] = Date.now();
    } catch (e) {}
  }
  let ni = 0;
  for (let i = 0; i < shotIncomes.length; i++) {
    if (!$("#si" + i).checked) continue;
    const t = shotIncomes[i];
    try { await api("/income", { amount: t.amount, cat: $("#sic" + i).value, note: $("#sim" + i).value.trim(), who: me, date: t.date }); ni++; seen[t.sig] = Date.now(); } catch (e) {}
  }
  LS.set("shotSeen", seen);
  closeSheet(); toast(`Добавлено: ${n} ${plural(n, "трата", "траты", "трат")}${toInbox ? ` (в «Разобрать»: ${toInbox})` : ""}${ni ? `, ${ni} в «Доходы»` : ""}`); load();
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
      <div class="small muted">${esc(c.name)}${t.who ? " · " + esc(t.who) : ""}${t.from === "pay" ? " · Apple Pay" + (t.auto ? " · авто" : "") : t.from === "rec" ? " · 🔁 каждый месяц" : ""}${t.rc ? " · 🧾" : ""}</div></div><div class="a">${fmt(t.amount)}</div></div>`;
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
  const full = S.role !== "partner";
  // the wife's phone gets its own key: the server keeps the 🙈 categories away from it
  const code = `${house.id}.${full && S.partnerKey ? S.partnerKey : house.key}`;
  const join = `${location.origin}/?join=${code}`;
  const hook = `${location.origin}/api/in/${house.id}/${house.key}`;
  app.innerHTML = `<h1>Ещё</h1>
    <h2>Семья</h2><div class="card">
      <div class="row"><b class="sp">${esc(S.name || "Семья")}</b></div>
      <label>Этот телефон</label>
      ${me ? `<div class="whoami">👤 ${esc(me)}</div>`
        : `<div class="small muted">Выберите один раз, чей это телефон:</div><div class="chips">${S.members.map((w) => `<button onclick="setMe('${esc(w)}')">👤 ${esc(w)}</button>`).join("")}<button onclick="addMember()">＋ добавить</button></div>`}
      ${full ? `<label>Подключить телефон жены</label>
      <div class="small muted">На её iPhone: Safari → эта ссылка → «Поделиться» → «На экран Домой»; открыть с иконки и вставить ссылку.</div>
      <div class="code">${esc(join)}</div>
      <button class="btn ghost" onclick="share('${esc(join)}')">📤 Отправить ссылку жене</button>
      <button class="btn ghost" onclick="renewPartner()">🔄 Новая ссылка для жены</button>` : ""}
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
      Виджет: отдельная команда с теми же шагами, но значение ключа <b>balanceText</b> («Баланс 5 633 zł · свободно 4 433 zł») или <b>leftText</b> («Осталось 1 234 zł») → «Показать результат»; добавьте виджет «Команды» на экран Домой.
      <div class="code">${esc(hook)}</div>
      <button class="btn ghost" onclick="copy('${esc(hook)}')">📋 Скопировать ссылку</button>
    </div>
    <h2>Выгрузка</h2><div class="card">
      <button class="btn ghost" style="margin-top:0" onclick="exportCsv()">📤 ${monthName(month)} в Excel (CSV)</button>
      <button class="btn ghost" onclick="exportYear()">📤 Весь ${month.slice(0, 4)} год (CSV)</button>
    </div>
    <h2>Категории</h2><div class="card">
      ${full && secret ? `<div class="small muted" style="margin-bottom:6px">🙈 — скрыть: на втором телефоне не будет ни категории, ни трат по ней, ни суммы; баланс там меньше на отложенное в ней.</div>` : ""}
      ${S.categories.map((c, i) => `<div class="cat"><input style="width:56px;text-align:center;margin:0" value="${esc(c.emoji)}" onchange="catEdit(${i},'emoji',this.value)">
        <input style="margin:0" value="${esc(c.name)}" onchange="catEdit(${i},'name',this.value)">
        ${full && secret ? `<button class="mini hide ${c.hidden ? "on" : ""}" onclick="catHide(${i})" aria-label="Скрыть">🙈</button>` : ""}
        <button class="btn ghost" style="width:auto;margin:0;padding:10px" onclick="catDel(${i})">✕</button></div>`).join("")}
      <button class="btn ghost" onclick="catAdd()">＋ Категория</button>
    </div>
    <h2>Установка</h2><div class="card small">На iPhone: Safari → кнопка «Поделиться» → <b>«На экран Домой»</b>. Бюджет откроется как обычное приложение.</div>
    ${full ? `<h2>Безопасность</h2><div class="card small">
      Ваш ключ есть в вашей ссылке «Команд». Если она попала к чужим людям — выдайте новый ключ: ваши старые ссылки перестанут работать (у жены свой ключ, его меняет «Новая ссылка для жены»).
      <button class="btn ghost" onclick="rekey()">🔑 Выдать новый ключ</button>
    </div>` : ""}
    <button class="btn red" style="margin-top:24px" onclick="leave()">Отключить этот телефон</button>`;
}
window.catHide = async (i) => {
  const c = S.categories[i];
  if (!c.hidden && !confirm(`Скрыть «${c.name}»?\n\nНа втором телефоне пропадут эта категория, траты по ней, сумма и заметка. Баланс там будет меньше на сумму, отложенную в этой категории.`)) return;
  c.hidden = !c.hidden;
  try { await api("/categories", { categories: S.categories }); toast(c.hidden ? "🙈 Скрыто" : "Снова видно"); load(); }
  catch (e) { c.hidden = !c.hidden; toast("Нет связи — попробуйте ещё раз"); }
};
window.renewPartner = async () => {
  if (!confirm("Сделать новую ссылку для жены?\n\nСтарая ссылка и её «Команды» перестанут работать — её телефон попросит новую ссылку.")) return;
  try { const r = await api("/partner", {}); S.partnerKey = r.partnerKey; render(); toast("🔄 Новая ссылка готова — отправьте жене"); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
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
// which person this phone is, set once (on creating or joining); it is not switched from «Ещё»
window.setMe = (w, force) => { if (me && w !== me && !force) return; me = w; LS.set("me", w); render(); };
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
window.leave = () => { if (!confirm("Отключить телефон от семейного бюджета? Данные останутся на сервере.")) return; localStorage.clear(); house = null; setState(null); render(); };

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

// ------------------------------------------------------------------ receipts

// a photo is made small on the phone: ≈1600 px JPEG for reading the receipt, 240 px for the list
function shrink(file, max, q) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error("image")); };
    img.src = url;
  });
}
async function readReceipt(file) {
  let img = await shrink(file, 1600, 0.72);
  if (img.length > 2400000) img = await shrink(file, 1200, 0.6);   // base64 ≈ 4/3 of the bytes; the server takes up to 1.9 MB
  return { img, thumb: await shrink(file, 240, 0.6) };
}
async function uploadReceipt(d, date) { return (await api("/receipt", { img: d.img, thumb: d.thumb, date, who: me })).id; }

// ------- the sum, the shop and the date from the photo of a Polish receipt («paragon fiskalny»)
const SHOPS = [
  [/biedronka|jeronimo/i, "Biedronka", "food"], [/\blidl\b/i, "Lidl", "food"], [/[żz]abka/i, "Żabka", "food"], [/kaufland/i, "Kaufland", "food"],
  [/auchan/i, "Auchan", "food"], [/carrefour/i, "Carrefour", "food"], [/\bnetto\b/i, "Netto", "food"], [/\bdino\b/i, "Dino", "food"],
  [/stokrotka/i, "Stokrotka", "food"], [/lewiatan/i, "Lewiatan", "food"], [/polomarket/i, "POLOmarket", "food"], [/\baldi\b/i, "Aldi", "food"],
  [/rossmann/i, "Rossmann", ""], [/\bhebe\b/i, "Hebe", ""], [/super-?pharm/i, "Super-Pharm", "health"], [/apteka/i, "Apteka", "health"],
  [/pepco/i, "Pepco", "clothes"], [/\baction\b/i, "Action", ""], [/sinsay/i, "Sinsay", "clothes"], [/reserved/i, "Reserved", "clothes"],
  [/\bh\s?&\s?m\b/i, "H&M", "clothes"], [/decathlon/i, "Decathlon", ""], [/\bikea\b/i, "IKEA", "home"], [/leroy/i, "Leroy Merlin", "home"],
  [/castorama/i, "Castorama", "home"], [/\bobi\b/i, "OBI", "home"], [/media\s?expert/i, "Media Expert", ""], [/euro\s?agd|rtv\s?euro/i, "RTV Euro AGD", ""],
  [/media\s?markt/i, "MediaMarkt", ""], [/orlen/i, "Orlen", "car"], [/\bbp\b/i, "BP", "car"], [/\bshell\b/i, "Shell", "car"], [/circle\s?k/i, "Circle K", "car"],
  [/\bmoya\b/i, "Moya", "car"], [/mcdonald/i, "McDonald's", "cafe"], [/\bkfc\b/i, "KFC", "cafe"], [/starbucks/i, "Starbucks", "cafe"],
];
function parseReceipt(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const A = String.raw`(\d{1,5}(?:[ \u00a0]\d{3})*[.,]\d{2})`;
  const pick = (re) => { for (const l of lines) { const m = l.match(re); if (m) return num(m[1]); } return 0; };
  // «SUMA PLN 20,96» (not «SUMA PTU» — the tax), then «RAZEM», «DO ZAPŁATY», then the card / cash line, else the biggest amount
  let amount = pick(new RegExp(String.raw`\bSUMA\b(?!\s*PTU)\D{0,12}` + A, "i")) || pick(new RegExp(String.raw`\b(?:RAZEM|DO\s*ZAP[ŁL]ATY|NALE[ŻZ]NO[ŚS][ĆC]|TOTAL)\b\D{0,12}` + A, "i"))
    || pick(new RegExp(String.raw`\b(?:KARTA|P[ŁL]ATNO[ŚS][ĆC]\s*KART|GOT[ÓO]WKA|BLIK)\D{0,25}` + A, "i"));
  if (!amount) { const all = (text.match(new RegExp(A, "g")) || []).map(num).filter((n) => n < 100000); amount = all.length ? Math.max(...all) : 0; }
  const shop = SHOPS.find(([re]) => re.test(text));
  let merchant = shop ? shop[1] : "";
  if (!merchant) merchant = (lines.find((l) => /\p{L}{3}/u.test(l) && !/paragon|fiskal|\bnip\b|^ul\.|sp\.?\s*z|s\.a\.|\d{2}-\d{3}/i.test(l)) || "").replace(/[^\p{L}\d .&'-]/gu, "").trim().slice(0, 40);
  let date = "";
  const d = text.match(/\b(20\d{2})[-.\/](\d{2})[-.\/](\d{2})\b/) || text.match(/\b(\d{2})[-.\/](\d{2})[-.\/](20\d{2})\b/);
  if (d) {
    const iso = d[1].length === 4 ? `${d[1]}-${d[2]}-${d[3]}` : `${d[3]}-${d[2]}-${d[1]}`;
    if (iso <= todayIso() && iso >= shiftDay(todayIso(), -90) && !isNaN(new Date(iso))) date = iso;
  }
  return { amount, merchant, date, cat: shop ? shop[2] : "" };
}
async function readReceiptText(img) {
  let r = null;
  try {
    const T = await loadTesseract();
    const { data } = await T.recognize(img, "pol", { logger: (m) => { const e = $("#rcState"); if (e && m.progress) e.textContent = Math.round(m.progress * 100) + "%"; } });
    r = parseReceipt(data.text);
  } catch (e) {}
  if (!draft || !draft.rcData || draft.rcData.img !== img) return;   // the sheet was closed or another photo picked
  const got = [];
  if (r && r.amount) { if (!Number(draft.amount)) draft.amount = String(r.amount); got.push(fmt(r.amount)); }
  if (r && r.merchant) { if (!draft.note) draft.note = r.merchant; got.push(esc(r.merchant)); }
  if (r && r.date) { if (draft.date === todayIso()) draft.date = r.date; got.push(r.date.slice(8, 10) + "." + r.date.slice(5, 7)); }
  if (r && !draft.cat) { const c = S.rules[shopKey(r.merchant)] || r.cat; if (c && S.categories.some((x) => x.id === c)) draft.cat = c; }
  draft.rcRead = got.length ? `🔎 С чека: ${got.join(" · ")} — проверьте` : "🔎 Сумму на чеке не нашёл — впишите сами";
  if ($("#sheet").classList.contains("on")) drawAdd();
}
window.saveReceiptOnly = async () => {
  const d = draft.rcData;
  closeSheet();
  try { const id = await uploadReceipt(d, draft.date); toast("🧾 Чек сохранён"); await load(); setTab("receipts"); openReceipt(id); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};

// where the picked photo goes: «add» (the new expense), «tx:<id>» (an expense), «new» (a receipt on its own)
let rcTarget = "";
window.pickReceipt = (target) => {
  // «Добавить чек» in «Чеки»: a new expense with the photo — its sum, shop and date are read from it; «только чек» keeps it alone
  if (target === "new") { openAdd(); target = "add"; }
  rcTarget = target; const f = $("#rcFile"); f.value = ""; f.click();
};
window.gotReceipt = async (files) => {
  const file = files && files[0];
  if (!file) return;
  toast("Обрабатываю фото…");
  let d;
  try { d = await readReceipt(file); } catch (e) { return toast("Не получилось прочитать фото"); }
  if (rcTarget === "add") { draft.rcData = d; draft.rcRead = "reading"; drawAdd(); readReceiptText(d.img); return; }
  try {
    if (rcTarget.startsWith("tx:")) {
      const t = S.tx.find((x) => x.id === rcTarget.slice(3));
      const id = await uploadReceipt(d, t ? t.date : todayIso());
      await api(`/receipt/${id}`, { tx: rcTarget.slice(3), month });
      closeSheet(); toast("🧾 Чек прикреплён");
    } else {
      const id = await uploadReceipt(d, month === todayIso().slice(0, 7) ? todayIso() : month + "-01");
      toast("🧾 Чек сохранён"); await load(); openReceipt(id); return;
    }
  } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
  load();
};

// pictures come with the key in a header, so they are fetched and shown from memory
const rcCache = {};
function rcUrl(id, thumb) {
  const k = id + (thumb ? ":t" : "");
  if (!rcCache[k]) rcCache[k] = fetch(`/api/h/${house.id}/receipt/${id}${thumb ? "?thumb=1" : ""}`, { headers: { "X-Key": house.key } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status)))).then((b) => URL.createObjectURL(b)).catch((e) => { delete rcCache[k]; throw e; });
  return rcCache[k];
}
function fillReceipts() {
  document.querySelectorAll("img[data-rc]:not([src])").forEach((el) => rcUrl(el.dataset.rc, el.dataset.thumb).then((u) => { el.src = u; }).catch(() => { el.alt = "нет связи"; }));
}

function renderReceipts() {
  const list = [...(S.receipts || [])].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const w = [...(S.warranties || [])].filter((r) => r.wty >= shiftDay(todayIso(), -30)).sort((a, b) => a.wty.localeCompare(b.wty));
  let html = monthHeader() + `<button class="btn" onclick="pickReceipt('new')">📷 Добавить чек</button>
    <div class="small muted" style="text-align:center;margin-top:6px">Сумма, магазин и дата прочитаются с фото. Чек можно прикрепить и к трате: «История» → трата → «📎».</div>
    ${w.length ? `<h2>🛡 На гарантии</h2><div class="card">${w.map((r) => `<div class="item" onclick="openReceipt('${r.id}')"><img class="rcmini big" data-rc="${r.id}" data-thumb="1" alt="">
      <div class="sp"><div>${esc(r.wtyName || r.note || "Покупка")}</div><div class="small ${r.wty < todayIso() ? "neg" : r.wty <= shiftDay(todayIso(), 30) ? "warn" : "muted"}">${wtyLeft(r.wty)}</div></div>
      <div class="a">${r.amount ? fmt(r.amount) : ""}</div></div>`).join("")}</div><h2>Чеки за ${MONTHS[Number(month.slice(5)) - 1]}</h2>` : ""}`;
  if (!list.length) return (app.innerHTML = html + `<div class="empty">🧾<br><br>Чеков за этот месяц нет. Сфотографируйте чек — для гарантии, возврата или просто на память.</div>`);
  let day = "";
  html += `<div class="rcgrid">`;
  for (const r of list) {
    const t = r.tx ? S.tx.find((x) => x.id === r.tx) : null;
    html += `<div class="rc" onclick="openReceipt('${r.id}')"><img data-rc="${r.id}" data-thumb="1" alt="">
      <div class="small"><b>${r.amount ? fmt(r.amount) : "—"}</b> · ${r.date.slice(8, 10)}.${r.date.slice(5, 7)}</div>
      <div class="small muted rcn">${r.wty && r.wty >= todayIso() ? "🛡 " : ""}${esc(t ? t.note || catOf(t.cat).name : r.note || (r.tx ? "" : "без траты"))}</div></div>`;
  }
  app.innerHTML = html + `</div>`;
}
window.openReceipt = (id) => {
  const r = (S.receipts || []).find((x) => x.id === id) || (S.warranties || []).find((x) => x.id === id) || { id, date: todayIso() };
  const t = r.tx ? S.tx.find((x) => x.id === r.tx) : null;
  openSheet(`<div class="row"><b class="sp">🧾 Чек · ${r.date.slice(8, 10)}.${r.date.slice(5, 7)}.${r.date.slice(0, 4)}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <div class="rcfull" onclick="this.classList.toggle('zoom')"><img data-rc="${id}" alt="Загрузка…"></div>
    <div class="small muted" style="margin-top:6px">Нажмите на фото, чтобы увеличить.</div>
    ${t ? `<div class="item" onclick="openEdit('${t.id}')"><div class="e">${catOf(t.cat).emoji}</div><div class="sp"><div>${esc(t.note || catOf(t.cat).name)}</div><div class="small muted">${esc(catOf(t.cat).name)}${t.who ? " · " + esc(t.who) : ""}</div></div><div class="a">${fmt(t.amount)}</div></div>`
      : `<button class="btn ghost" onclick="linkReceipt('${id}')">🔗 Привязать к трате</button>`}
    <h2>🛡 Гарантия</h2><div class="card">${r.wty ? `<div class="row"><div class="sp"><b>${esc(r.wtyName || (t && t.note) || "Покупка")}</b>
        <div class="small ${r.wty < todayIso() ? "neg" : "muted"}">${wtyLeft(r.wty)}</div></div><button class="mini" onclick="setWty('${id}','')">Убрать</button></div>`
      : `<div class="small muted">На что гарантия и сколько. Чек будет в «Чеки» → «На гарантии», а за месяц до конца появится напоминание.</div>`}
      <input id="wName" placeholder="Что: пылесос, телефон, обувь…" value="${esc(r.wtyName || (t && t.note) || r.note || "")}">
      <div class="chips">${[[12, "1 год"], [24, "2 года"], [36, "3 года"], [60, "5 лет"]].map(([m, n]) => `<button onclick="setWty('${id}', addMonths('${r.date}', ${m}))">${n}</button>`).join("")}
        <input id="wDate" type="date" style="width:auto;margin:0;padding:6px 10px" value="${r.wty || ""}" onchange="setWty('${id}', this.value)"></div></div>
    <button class="btn red" onclick="delReceipt('${id}')">Удалить чек</button>`);
};
const addMonths = (iso, m) => { const d = new Date(iso + "T12:00:00"); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
window.addMonths = addMonths;
function wtyLeft(w) {
  const days = Math.round((new Date(w + "T12:00:00") - new Date(todayIso() + "T12:00:00")) / 864e5);
  const date = `${w.slice(8, 10)}.${w.slice(5, 7)}.${w.slice(0, 4)}`;
  if (days < 0) return `гарантия кончилась ${date}`;
  if (days <= 60) return `до ${date} · осталось ${days} ${plural(days, "день", "дня", "дней")}`;
  const mo = Math.round(days / 30.4);
  return `до ${date} · осталось ${mo} ${plural(mo, "месяц", "месяца", "месяцев")}`;
}
window.setWty = async (id, wty) => {
  try { await api(`/receipt/${id}`, { wty, wtyName: ($("#wName") || {}).value || "" }); toast(wty ? "🛡 Гарантия до " + wty.slice(8, 10) + "." + wty.slice(5, 7) + "." + wty.slice(0, 4) : "Гарантия убрана"); await load(); openReceipt(id); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.linkReceipt = (id) => {
  const free = S.tx.filter((t) => !t.rc).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  openSheet(`<div class="row"><b class="sp">К какой трате?</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="openReceipt('${id}')">‹</button></div>
    ${free.length ? free.map((t) => `<div class="item" onclick="doLink('${id}','${t.id}')"><div class="e">${catOf(t.cat).emoji}</div><div class="sp"><div>${esc(t.note || catOf(t.cat).name)}</div>
      <div class="small muted">${t.date.slice(8, 10)}.${t.date.slice(5, 7)} · ${esc(catOf(t.cat).name)}</div></div><div class="a">${fmt(t.amount)}</div></div>`).join("") : `<div class="empty">В этом месяце нет трат без чека</div>`}`);
};
window.doLink = async (id, tx) => { try { await api(`/receipt/${id}`, { tx, month }); toast("🔗 Привязано"); await load(); openReceipt(id); } catch (e) { toast("Нет связи — попробуйте ещё раз"); } };
window.delReceipt = async (id) => {
  if (!confirm("Удалить фото чека? Трата останется.")) return;
  try { await api(`/receipt/${id}`, { delete: true }); closeSheet(); toast("Чек удалён"); load(); } catch (e) { toast("Нет связи — попробуйте ещё раз"); }
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
  house = { id: r.id, key: r.key }; LS.set("house", house); setMe(who, true);
  $("#tabs").style.display = ""; await load(); toast("Бюджет создан");
};
window.joinBy = async (raw, who) => {
  const m = String(raw || "").match(/([a-z0-9]{10})\.([a-z0-9]{16})/);
  if (!m) return toast("Код не похож на код бюджета");
  house = { id: m[1], key: m[2] }; LS.set("house", house);
  $("#tabs").style.display = "";
  try { await api("/state"); } catch (e) { house = null; LS.set("house", null); renderStart(); return toast("Код не подходит"); }
  if (who && who.trim()) { await api("/member", { who: who.trim() }); setMe(who.trim(), true); }
  history.replaceState(null, "", "/");
  await load(); toast("Подключено");
};

// ------------------------------------------------------------------ sheets: add, edit, plan

function openSheet(html) { const s = $("#sheet"); s.innerHTML = `<div class="in">${html}</div>`; s.classList.add("on"); fillReceipts(); }
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
    <div class="cats">${S.categories.map((c) => `<button class="${d.cat === c.id ? "on" : ""}" onclick="pickCat('${c.id}')"><span>${c.emoji}</span>${esc(c.name)}${c.hidden ? " 🙈" : ""}</button>`).join("")}</div>
    <input id="note" placeholder="Заметка (необязательно)" value="${esc(d.note)}" oninput="draft.note=this.value">
    <div class="chips">${[["Сегодня", todayIso()], ["Вчера", shiftDay(todayIso(), -1)]].map(([n, v]) => `<button class="${d.date === v ? "sug" : ""}" onclick="draft.date='${v}';drawAdd()">${n}</button>`).join("")}
      <input type="date" style="width:auto;margin:0;padding:6px 10px" value="${d.date}" onchange="draft.date=this.value"></div>
    ${S.members.length > 1 ? `<div class="chips">${S.members.map((w) => `<button class="${d.who === w ? "sug" : ""}" onclick="draft.who='${esc(w)}';drawAdd()">👤 ${esc(w)}</button>`).join("")}</div>` : ""}
    <button class="btn ghost" onclick="pickReceipt('add')">${d.rcData ? `<img class="rcmini" src="${d.rcData.thumb}"> Чек прикреплён ✓ (заменить)` : "📎 Фото чека"}</button>
    ${d.rcRead === "reading" ? `<div class="small muted rcread">🔎 Читаю чек… <span id="rcState"></span></div>` : d.rcRead ? `<div class="small rcread">${d.rcRead}</div>` : ""}
    <button class="btn" onclick="saveAdd()">Сохранить${d.cat ? "" : " в «Разобрать»"}</button>
    ${d.rcData ? `<button class="btn ghost" onclick="saveReceiptOnly()">Сохранить только чек, без траты</button>` : ""}`);
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
  const { rcData, ...rest } = draft;
  const t = { ...rest, amount: Number(draft.amount) };
  closeSheet();
  try {
    if (rcData) t.rc = await uploadReceipt(rcData, t.date);
    await api("/tx", t); toast((draft.cat ? catOf(draft.cat).emoji + " " : "📥 ") + fmt(t.amount) + (rcData ? " · 🧾" : ""));
  }
  catch (e) { delete t.rc; const q = LS.get("queue", []); q.push(t); LS.set("queue", q); toast(rcData ? "Нет интернета — трата сохранится позже, чек нет" : "Нет интернета — сохраню позже"); }
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
    ${t.rc ? `<label>Чек</label><img class="rcthumb" data-rc="${t.rc}" data-thumb="1" onclick="openReceipt('${t.rc}')">` : ""}
    <button class="btn ghost" onclick="pickReceipt('tx:${id}')">${t.rc ? "📎 Заменить фото чека" : "📎 Прикрепить фото чека"}</button>
    <button class="btn" onclick="saveEdit('${id}')">Сохранить</button>
    <button class="btn red" onclick="delTx('${id}')">Удалить${t.rc ? " (вместе с чеком)" : ""}</button>`);
};
window.saveEdit = async (id) => {
  const cat = $("#sheet .cats button.on")?.dataset.id;
  await api(`/tx/${id}?month=${month}`, { amount: $("#eAmount").value, note: $("#eNote").value, date: $("#eDate").value, cat });
  closeSheet(); load();
};
window.delTx = async (id) => { if (!confirm("Удалить трату?")) return; await api(`/tx/${id}?month=${month}`, { delete: true }); closeSheet(); load(); };

// draft: what was typed before «＋ Категория» re-drew the sheet
window.openPlan = (draft) => {
  const lim = draft ? draft.limits : S.plan.limits || {}, keep = draft ? draft.keep : S.plan.keep || {};
  const { by } = sums();
  openSheet(`<div class="row"><b class="sp">Суммы на ${monthName(month).toLowerCase()}</b><button class="btn ghost" style="width:auto;margin:0;padding:8px 12px" onclick="closeSheet()">✕</button></div>
    <label>Сколько есть на месяц (доход), zł${(S.inc || []).length ? ` — уже пришло ${fmt0(S.inc.reduce((a, t) => a + t.amount, 0))}` : ""}</label><input id="pIncome" inputmode="decimal" value="${draft ? esc(draft.income) : S.plan.income || ""}" oninput="planLeft()">
    <div id="pLeft" class="small" style="margin-top:6px"></div>
    <h2>Сколько надо по категориям</h2>
    <div class="small muted">Галочка ↪ — сумма перейдёт на следующий месяц. Снимите для разового: подарок, ремонт, поездка.</div>
    ${secret && S.role !== "partner" ? `<div class="small muted" style="margin-top:4px">🙈 — скрыть (видно только в этом режиме).</div>` : ""}
    ${S.categories.map((c) => `<div class="cat"><div class="e">${c.emoji}</div><div class="sp"><div class="n">${esc(c.name)}</div>
      <label class="keep"><input type="checkbox" class="keepc" data-id="${c.id}" ${keep[c.id] === false ? "" : "checked"}> ↪ на след. месяц</label>
      ${by[c.id] ? `<div class="small muted">потрачено ${fmt0(by[c.id])}</div>` : ""}</div>
      ${secret && S.role !== "partner" ? `<button class="mini hide ${c.hidden ? "on" : ""}" onclick="planHide('${c.id}')" aria-label="Скрыть">🙈</button>` : ""}
      <input class="lim" data-id="${c.id}" inputmode="decimal" style="width:100px;margin:0;text-align:right" placeholder="0" value="${lim[c.id] || ""}" oninput="planLeft()"></div>`).join("")}
    <button class="btn ghost" onclick="planCatAdd()">＋ Категория</button>
    <button class="btn" onclick="savePlan()">Сохранить</button>`);
  planLeft();
};
function planDraft() {
  const limits = {}, keep = {};
  document.querySelectorAll(".lim").forEach((e) => { if (e.value) limits[e.dataset.id] = e.value; });
  document.querySelectorAll(".keepc").forEach((e) => { if (!e.checked) keep[e.dataset.id] = false; });
  return { income: $("#pIncome").value, limits, keep };
}
// 🙈 right in «Суммы» (only with the secret look on): what was typed stays
window.planHide = async (id) => {
  const draft = planDraft(), c = S.categories.find((x) => x.id === id);
  c.hidden = !c.hidden;
  try { await api("/categories", { categories: S.categories }); openPlan(draft); toast(c.hidden ? "🙈 Скрыто" : "Снова видно"); }
  catch (e) { c.hidden = !c.hidden; toast("Нет связи — попробуйте ещё раз"); }
};
window.planCatAdd = async () => {
  const draft = planDraft();
  const raw = (prompt("Название категории (можно с эмодзи в начале, например «🎂 День рождения»):") || "").trim();
  if (!raw) return;
  const m = raw.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*(.*)$/u);
  const c = { id: Math.random().toString(36).slice(2, 8), emoji: m ? m[1] : "🏷", name: (m ? m[2] : raw).slice(0, 24) || raw.slice(0, 24) };
  try { await api("/categories", { categories: [...S.categories, c] }); S.categories.push(c); openPlan(draft); setTimeout(() => document.querySelector(`.lim[data-id="${c.id}"]`)?.focus(), 50); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
};
window.planLeft = () => {
  const inc = Number(String($("#pIncome").value).replace(",", ".")) || 0;
  const sum = [...document.querySelectorAll(".lim")].reduce((a, e) => a + (Number(String(e.value).replace(",", ".")) || 0), 0);
  const left = inc - sum;
  $("#pLeft").innerHTML = inc ? (left >= 0 ? `Распределено ${fmt0(sum)} · <b>свободно ${fmt0(left)}</b>` : `<span style="color:var(--red)">Распределено больше дохода на ${fmt0(-left)}</span>`) : `Распределено ${fmt0(sum)}`;
};
window.savePlan = async () => {
  const d = planDraft();
  try { await api("/plan", { month, income: d.income, limits: d.limits, keep: d.keep }); closeSheet(); toast("Сохранено"); load(); }
  catch (e) { toast("Нет связи — попробуйте ещё раз"); }
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
