import { SUPABASE_URL, SUPABASE_ANON_KEY, SITES, POSITIONS, DEFAULT_TAGS, HERO_NICKS, PKO_SHOWS_FULL_BOUNTY } from "./config.js";
import { buildPayoutsJson, buildPokerStarsHH, checkPayouts } from "./hrc.js";

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const weekStart = s => { const d = parse(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); };
const shortDate = s => s ? parse(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const DOW = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const CATS = { grind: ["Grind", "♠"], estudo: ["Estudo", "♦"], plantao: ["Plantão", "?"], pessoal: ["Pessoal", "♥"], outro: ["Outro", "♣"] };
const cat = c => CATS[c] ? c : "outro";
const suit = c => `<span class="suit c-${cat(c)}" title="${CATS[cat(c)][0]}">${CATS[cat(c)][1]}</span>`;
const STREETS = { preflop: "Pré-flop", flop: "Flop", turn: "Turn", river: "River" };
const streetTag = s => STREETS[s] ? `<span class="street ${s}">${STREETS[s]}</span>` : "";

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2400);
}
function fail(e, what) {
  console.error(e);
  toast(`Não deu para ${what}: ${e?.message || e}`, true);
}

/* ================= supabase ================= */
const configured = !SUPABASE_URL.startsWith("COLE_") && !!window.supabase;
const sb = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const S = { user: null, hands: [], images: [], decisions: [], comments: [], shares: [], events: [], tasks: [], pregrind: [], leaks: [], tags: [], urls: new Map() };

async function q(promise, what) {
  const { data, error } = await promise;
  if (error) { fail(error, what); throw error; }
  return data;
}

async function loadAll() {
  const [hands, images, decisions, events, tasks, pregrind, leaks, tags, comments, shares] = await Promise.all([
    q(sb.from("hands").select("*").order("created_at", { ascending: false }), "carregar as mãos"),
    q(sb.from("hand_images").select("*").order("sort"), "carregar os prints"),
    q(sb.from("decisions").select("*").order("sort"), "carregar as dúvidas (rodou o SQL 003?)"),
    q(sb.from("events").select("*"), "carregar a agenda"),
    q(sb.from("tasks").select("*").order("created_at"), "carregar as tarefas"),
    q(sb.from("pregrind").select("*").order("created_at"), "carregar o pré-grind"),
    q(sb.from("leaks").select("*").order("created_at"), "carregar os leaks"),
    q(sb.from("tags").select("*").order("sort"), "carregar os spots"),
    q(sb.from("comments").select("*").order("created_at"), "carregar os comentários (rodou o SQL 004?)").catch(() => []),
    sb.from("shares").select("*").order("created_at", { ascending: false }).then(r => r.error ? [] : r.data)
  ]);
  Object.assign(S, { hands, images, decisions, events, tasks, pregrind, leaks, tags, comments, shares });
  if (!tags.length) {
    const rows = DEFAULT_TAGS.map((name, i) => ({ user_id: S.user.id, name, sort: i }));
    const { error } = await sb.from("tags").upsert(rows, { onConflict: "user_id,name", ignoreDuplicates: true });
    if (error) console.error(error);
    S.tags = await q(sb.from("tags").select("*").order("sort"), "carregar os spots");
  }
  await signImages([...images.map(i => i.path), ...comments.flatMap(c => c.images || [])]);
}

async function signImages(paths) {
  const missing = paths.filter(p => !S.urls.has(p));
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await sb.storage.from("hands").createSignedUrls(missing.slice(i, i + 100), 60 * 60 * 12);
    if (error) { console.error(error); continue; }
    data.forEach(d => { if (d.signedUrl) S.urls.set(d.path, d.signedUrl); });
  }
}
const imagesOf = id => S.images.filter(i => i.hand_id === id && i.kind !== "lobby").sort((a, b) => a.sort - b.sort);
const lobbyOf = id => S.images.filter(i => i.hand_id === id && i.kind === "lobby").sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
const isLobbyCaption = c => /^\s*lobby/i.test(c || "");
const decisionsOf = id => S.decisions.filter(d => d.hand_id === id).sort((a, b) => a.sort - b.sort);
const commentsOf = id => S.comments.filter(c => c.decision_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
// uma dúvida do plantão conta como respondida se tem resposta, comentário fixado ou está resolvida
const isAnswered = d => !!(d.plantao_answer || d.status === "revisada" || (d.id && S.comments.some(c => c.decision_id === d.id && c.pinned)));

/* ================= auth ================= */
async function boot() {
  if (!configured) {
    $("#login").hidden = false;
    $("#login-msg").innerHTML = "Falta configurar o Supabase em <code>js/config.js</code>.";
    $("#login-form").querySelectorAll("input,button").forEach(el => { el.disabled = true; });
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((ev, s) => {
    if (ev === "SIGNED_OUT") location.reload();
    if (ev === "SIGNED_IN" && !S.user && s) start(s.user);
  });
  if (session) start(session.user); else $("#login").hidden = false;
}

async function start(user) {
  S.user = user;
  $("#login").hidden = true;
  $("#who-mail").textContent = user.email;
  $("#avatar").textContent = (user.email || "?").slice(0, 2).toUpperCase();
  try { await loadAll(); } catch { /* já avisado */ }
  $("#app").hidden = false;
  fillStaticSelects();
  route(); renderAll();
}

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#login-btn"); btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-pass").value });
  btn.disabled = false;
  if (error) $("#login-msg").textContent = "E-mail ou senha incorretos. " + (error.message.includes("confirm") ? "Confirme o e-mail antes de entrar." : "");
});
$("#signup-btn").addEventListener("click", async () => {
  const email = $("#login-email").value.trim(), password = $("#login-pass").value;
  if (!email || password.length < 6) { $("#login-msg").textContent = "Preencha e-mail e uma senha com pelo menos 6 caracteres."; return; }
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { $("#login-msg").textContent = "Não deu para criar a conta: " + error.message; return; }
  $("#login-msg").textContent = data.session ? "Conta criada!" : "Conta criada. Abra o e-mail de confirmação e depois entre aqui.";
});
$("#logout").addEventListener("click", () => sb.auth.signOut());

/* ================= routing ================= */
const VIEWS = ["hoje", "agenda", "pregrind", "entrada", "maos", "duvida", "plantao", "leaks", "ajustes"];
let currentDec = null;
let view = "hoje";
function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("duvida-")) { view = "duvida"; currentDec = hash.slice(7); showIdx = null; }
  else view = VIEWS.includes(hash) ? hash : "hoje";
  VIEWS.forEach(v => { $("#v-" + v).hidden = v !== view; });
  const navView = view === "duvida" ? (backTo === "plantao" ? "plantao" : "maos") : view;
  $$(".side-nav a").forEach(a => { if (a.dataset.view === navView) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  closeSide();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => { route(); renderAll(); });
const openSide = () => { $("#side").classList.add("open"); $("#scrim").hidden = false; };
const closeSide = () => { $("#side").classList.remove("open"); $("#scrim").hidden = true; };
$("#side-open").addEventListener("click", openSide);
$("#side-close").addEventListener("click", closeSide);
$("#scrim").addEventListener("click", closeSide);

/* ================= render ================= */
function renderAll() { renderShares(); renderBadges(); renderToday(); renderAgenda(); renderPregrind(); renderInbox(); renderLibrary(); renderPlantao(); renderLeaks(); renderTags(); if (view === "duvida") renderDoubt(); }

function counts() {
  return {
    rever: S.decisions.filter(d => d.status !== "revisada").length,
    plantao: S.decisions.filter(d => d.plantao && !isAnswered(d)).length,
    pregrind: S.pregrind.filter(p => !p.done).length
  };
}
function renderBadges() {
  const c = counts();
  [["#b-entrada", S.hands.filter(isInbox).length], ["#b-maos", c.rever], ["#b-plantao", c.plantao], ["#b-pregrind", c.pregrind]].forEach(([sel, n]) => {
    const b = $(sel); b.hidden = !n; b.textContent = n;
  });
}

/* ---- hoje ---- */
const eventsOn = d => S.events.filter(e => e.day === d).sort((a, b) => (a.start_time || "99").localeCompare(b.start_time || "99"));
function evRow(e) {
  const when = e.start_time ? e.start_time + (e.end_time ? `<br>${e.end_time}` : "") : "dia todo";
  return `<li data-ev="${e.id}"><span class="when">${when}</span>${suit(e.category)}<div style="min-width:0"><div class="ev-t">${esc(e.title)}</div>${e.note ? `<div class="ev-n">${esc(e.note)}</div>` : ""}</div></li>`;
}
function renderToday() {
  const t = today();
  const title = parse(t).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  $("#today-title").textContent = title.charAt(0).toUpperCase() + title.slice(1);
  const c = counts();
  $("#kpis").innerHTML = `
    <a class="kpi gold" href="#maos"><b>${c.rever}</b><span>Dúvidas abertas</span></a>
    <a class="kpi" href="#plantao"><b>${c.plantao}</b><span>Dúvidas pro plantão</span></a>
    <a class="kpi green" href="#pregrind"><b>${c.pregrind}</b><span>Lembretes do pré-grind</span></a>`;
  const evs = eventsOn(t);
  $("#today-events").innerHTML = evs.length ? evs.map(evRow).join("") : `<li style="display:block;cursor:default"><p class="empty">Nada agendado para hoje.</p></li>`;
  let next = "";
  for (let i = 1; i <= 3; i++) {
    const d = addDays(t, i), e = eventsOn(d);
    if (e.length) next += `<p class="next-h">${parse(d).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric" })}</p><ul class="timeline">${e.map(evRow).join("")}</ul>`;
  }
  $("#next-days").innerHTML = next;
  const tasks = S.tasks.filter(k => !k.done || k.done_on === t).sort((a, b) => a.done - b.done);
  $("#task-list").innerHTML = tasks.length ? tasks.map(k => `
    <li class="${k.done ? "done" : ""}" data-task="${k.id}">
      <input type="checkbox" ${k.done ? "checked" : ""} aria-label="Concluir">
      ${suit(k.category)}<span class="txt">${esc(k.text)}</span>
      <button class="x" type="button" data-del-task aria-label="Excluir">×</button></li>`).join("")
    : `<li style="display:block"><p class="empty">Sem tarefas pendentes.</p></li>`;
}

/* ---- agenda ---- */
let weekRef = weekStart(today());
function renderAgenda() {
  const ws = weekRef, a = parse(ws), b = parse(addDays(ws, 6)), t = today();
  const mo = d => d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  $("#week-title").textContent = a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} de ${b.toLocaleDateString("pt-BR", { month: "long" })}`
    : `${a.getDate()} ${mo(a)} – ${b.getDate()} ${mo(b)}`;
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    html += `<div class="day ${d === t ? "today" : ""}"><div class="day-h"><b>${parse(d).getDate()}</b><span>${DOW[i]}</span></div>
      ${eventsOn(d).map(e => `<button type="button" class="ev c-${cat(e.category)}" data-ev="${e.id}">${e.start_time ? `<span class="tm">${e.start_time}${e.end_time ? "–" + e.end_time : ""}</span>` : ""}<span class="tt">${CATS[cat(e.category)][1]} ${esc(e.title)}</span></button>`).join("")}
      <button type="button" class="add" data-new-event="${d}">+ adicionar</button></div>`;
  }
  $("#week").innerHTML = html;
}

/* ---- pré-grind ---- */
function renderPregrind() {
  const items = [...S.pregrind].sort((a, b) => a.done - b.done);
  $("#pg-list").innerHTML = items.length ? items.map(p => `
    <li class="${p.done ? "done" : ""}" data-pg="${p.id}">
      <input type="checkbox" ${p.done ? "checked" : ""} aria-label="Marcar">
      <span class="txt">${esc(p.text)}</span>
      <button class="x" type="button" data-del-pg aria-label="Excluir">×</button></li>`).join("")
    : `<li style="display:block"><p class="empty">Nenhum lembrete. Anote aqui ajustes que você quer aplicar no próximo grind.</p></li>`;
}

/* ---- biblioteca (um card por dúvida) ---- */
const F = { q: "", status: "rever", tag: "", site: "", leak: "" };
const isInbox = h => h.status === "inbox";
function libraryItems() {
  const handById = new Map(S.hands.filter(h => !isInbox(h)).map(h => [h.id, h]));
  const items = [];
  for (const d of S.decisions) { const h = handById.get(d.hand_id); if (h) items.push({ d, h }); }
  // mãos sem nenhuma dúvida ainda aparecem como um card da mão
  const withDec = new Set(S.decisions.map(d => d.hand_id));
  for (const h of S.hands) if (!isInbox(h) && !withDec.has(h.id)) items.push({ d: { id: null, hand_id: h.id, status: "rever", tags: [], sort: 0 }, h });
  const order = new Map(S.hands.map((h, i) => [h.id, i]));
  return items.sort((a, b) => (order.get(a.h.id) - order.get(b.h.id)) || (a.d.sort - b.d.sort));
}
function decCard({ d, h }) {
  const imgs = imagesOf(h.id);
  const img = (d.image_id && imgs.find(i => i.id === d.image_id)) || imgs[0];
  const url = img && S.urls.get(img.path);
  const all = decisionsOf(h.id), idx = all.findIndex(x => x.id === d.id);
  const pin = d.id ? commentsOf(d.id).find(c => c.pinned) : null;
  const answer = d.plantao_answer || pin?.body || d.conclusion;
  const showAnswer = view === "plantao" && isAnswered(d) && answer;
  const ncm = d.id ? commentsOf(d.id).length : 0;
  return `<button type="button" class="hand ${SEL.ids.has(d.id) ? "picked" : ""}" data-hand="${h.id}" ${d.id ? `data-dec="${d.id}"` : ""}>
    <div class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<span class="noimg">?</span>`}${imgs.length > 1 ? `<span class="n">${imgs.length} prints</span>` : ""}</div>
    <div class="body">
      <div class="top">${streetTag(d.street)}${h.hero_cards ? `<span class="cards">${esc(h.hero_cards.split(" · ")[0])}</span>` : ""}${h.position ? `<span class="pos">${esc(h.position)}</span>` : ""}
        ${d.plantao ? `<span class="st pl">plantão</span>` : ""}<span class="st ${d.status === "revisada" ? "revisada" : "rever"}">${d.status === "revisada" ? "resolvida" : "aberta"}</span></div>
      ${h.tournament || h.site ? `<div class="tour">${esc([h.site, h.tournament].filter(Boolean).join(" · "))}${h.played_on ? " · " + shortDate(h.played_on) : ""}</div>` : ""}
      ${d.question ? `<div class="q">${esc(d.question)}</div>` : `<div class="q muted">Sem dúvida escrita</div>`}
      ${d.situation ? `<div class="sit">${esc(d.situation)}</div>` : ""}
      ${showAnswer ? `<div class="ans">↳ ${esc(answer)}</div>` : ""}
      ${d.tags?.length ? `<div class="tags">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      ${(all.length > 1 && idx >= 0) || ncm ? `<div class="of">${all.length > 1 && idx >= 0 ? `dúvida ${idx + 1} de ${all.length} nesta mão` : ""}${all.length > 1 && idx >= 0 && ncm ? " · " : ""}${ncm ? `${ncm} comentário${ncm === 1 ? "" : "s"}` : ""}</div>` : ""}
    </div></button>`;
}
function renderLibrary() {
  $("#f-tag").innerHTML = `<option value="">Todos os spots</option>` + S.tags.map(t => `<option ${F.tag === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#f-leak").innerHTML = `<option value="">Qualquer leak</option>` + S.leaks.map(l => `<option value="${l.id}" ${F.leak === l.id ? "selected" : ""}>${esc(l.title)}</option>`).join("");
  const list = filteredItems();
  if (!list.length) {
    $("#hand-grid").innerHTML = `<p class="empty">${S.hands.length ? "Nenhuma dúvida com esses filtros." : "Nenhuma mão ainda. Cole um print aqui ou clique em “+ Nova mão”."}</p>`;
    return;
  }
  // agrupa pelo dia em que a mão foi enviada (só aparecem dias que têm mãos)
  const groups = [];
  for (const it of list) {
    const k = iso(new Date(it.h.created_at));
    let g = groups[groups.length - 1];
    if (!g || g.key !== k) { g = { key: k, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  groups.sort((a, b) => b.key.localeCompare(a.key));
  const forced = !!(F.q || F.tag || F.site || F.leak); // com busca/filtro, abre tudo
  $("#hand-grid").innerHTML = groups.map((g, i) => {
    const open = forced || (g.key in dayOpen ? dayOpen[g.key] : i < 3);
    const nOpen = g.items.filter(x => x.d.status !== "revisada").length;
    const nHands = new Set(g.items.map(x => x.h.id)).size;
    const cnt = F.status === "rever" ? `${nOpen} aberta${nOpen === 1 ? "" : "s"}`
      : F.status === "revisada" ? `${g.items.length} resolvida${g.items.length === 1 ? "" : "s"}`
      : nOpen ? `${nOpen} aberta${nOpen === 1 ? "" : "s"} de ${g.items.length}` : "tudo resolvido";
    return `<section>
      <button type="button" class="day-h2" data-day="${g.key}" aria-expanded="${open}">
        <span class="chev">▾</span><b>${dayTitle(g.key)}</b><span class="dt">${dayDate(g.key)}</span>
        <span class="spacer"></span>${SEL.on ? `<span class="day-sel" data-day-sel="${g.key}">${g.items.every(x => !x.d.id || SEL.ids.has(x.d.id)) ? "tirar o dia" : "selecionar o dia"}</span>` : ""}<span class="cnt">${nHands} mão${nHands === 1 ? "" : "s"} · </span><span class="cnt ${nOpen && F.status !== "revisada" ? "has-open" : ""}">${cnt}</span>
      </button>
      ${open ? `<div class="hand-grid">${g.items.map(decCard).join("")}</div>` : ""}
    </section>`;
  }).join("");
}
let dayOpen = (() => { try { return JSON.parse(localStorage.getItem("dm-dias") || "{}"); } catch { return {}; } })();
function dayTitle(k) {
  const t = today();
  if (k === t) return "Hoje";
  if (k === addDays(t, -1)) return "Ontem";
  const w = parse(k).toLocaleDateString("pt-BR", { weekday: "long" });
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function dayDate(k) {
  const d = parse(k), sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("pt-BR", sameYear ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" });
}
$("#hand-grid").addEventListener("click", e => {
  const ds = e.target.closest("[data-day-sel]");
  if (ds) {
    const items = filteredItems().filter(x => x.d.id && iso(new Date(x.h.created_at)) === ds.dataset.daySel);
    const all = items.every(x => SEL.ids.has(x.d.id));
    items.forEach(x => all ? SEL.ids.delete(x.d.id) : SEL.ids.add(x.d.id));
    renderLibrary(); renderSelbar(); return;
  }
  const b = e.target.closest("[data-day]"); if (!b) return;
  dayOpen[b.dataset.day] = b.getAttribute("aria-expanded") !== "true";
  try { localStorage.setItem("dm-dias", JSON.stringify(dayOpen)); } catch { }
  renderLibrary();
});
function filteredItems() {
  const words = F.q.toLowerCase().split(/\s+/).filter(Boolean);
  return libraryItems().filter(({ d, h }) => {
    if (F.status === "rever" && d.status === "revisada") return false;
    if (F.status === "revisada" && d.status !== "revisada") return false;
    if (F.tag && !d.tags?.includes(F.tag)) return false;
    if (F.site && h.site !== F.site) return false;
    if (F.leak && d.leak_id !== F.leak) return false;
    if (words.length) {
      const caps = imagesOf(h.id).map(i => i.caption || "");
      const cmts = d.id ? commentsOf(d.id).map(c => c.body || "") : [];
      const hay = [h.tournament, h.situation, h.hero_cards, h.board, h.site, h.position, d.situation, d.question, d.conclusion, d.plantao_answer, STREETS[d.street], ...(d.tags || []), ...caps, ...cmts].join(" ").toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });
}
$("#f-q").addEventListener("input", e => { F.q = e.target.value; renderLibrary(); });
$("#f-tag").addEventListener("change", e => { F.tag = e.target.value; renderLibrary(); });
$("#f-site").addEventListener("change", e => { F.site = e.target.value; renderLibrary(); });
$("#f-leak").addEventListener("change", e => { F.leak = e.target.value; renderLibrary(); });
$("#f-status").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  F.status = b.dataset.s; $$("#f-status button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderLibrary();
});

/* ---- plantão ---- */
function renderPlantao() {
  const items = libraryItems().filter(({ d }) => d.plantao);
  const open = items.filter(({ d }) => !isAnswered(d)), done = items.filter(({ d }) => isAnswered(d)).slice(0, 40);
  $("#pl-count").textContent = open.length ? `(${open.length})` : "";
  $("#pl-open").innerHTML = open.length ? open.map(decCard).join("") : `<p class="empty" style="grid-column:1/-1">Nada pendente. Marque “Levar pro plantão” numa dúvida ou crie uma dúvida sem mão.</p>`;
  $("#pl-done").innerHTML = done.length ? done.map(decCard).join("") : `<p class="empty" style="grid-column:1/-1">As respostas do coach vão aparecer aqui.</p>`;
}

/* ---- leaks ---- */
function renderLeaks() {
  $("#leak-list").innerHTML = S.leaks.length ? S.leaks.map(l => {
    const n = S.decisions.filter(d => d.leak_id === l.id).length;
    return `<li class="${l.status === "corrigido" ? "fixed" : ""}" data-leak="${l.id}">
      <input type="checkbox" ${l.status === "corrigido" ? "checked" : ""} title="Marcar como corrigido" aria-label="Corrigido" style="width:18px;height:18px;accent-color:var(--accent)">
      <div style="min-width:0"><div class="t">${esc(l.title)}</div>${l.description ? `<div class="d">${esc(l.description)}</div>` : ""}</div>
      <button class="cnt" type="button" data-leak-hands>${n} ${n === 1 ? "dúvida" : "dúvidas"}</button>
      <button class="x" type="button" data-del-leak aria-label="Excluir">×</button></li>`;
  }).join("") : `<li style="display:block;border:0"><p class="empty">Nenhum leak anotado.</p></li>`;
}

/* ---- ajustes ---- */
function renderShares() {
  const el = $("#share-list"); if (!el) return;
  el.innerHTML = S.shares.length ? S.shares.map(sh => `
    <div class="sh ${sh.revoked ? "off" : ""}" data-share="${sh.id}">
      <div class="t"><b>${esc(sh.title || "Estudo compartilhado")}</b><span>${sh.decision_ids.length} dúvida${sh.decision_ids.length === 1 ? "" : "s"} · ${shortDate(iso(new Date(sh.created_at)))}${sh.revoked ? " · desativado" : ""}</span></div>
      ${sh.revoked ? `<button class="btn sm" type="button" data-sh-act="on">Reativar</button>` : `
        <button class="btn sm" type="button" data-sh-act="copy">Copiar link</button>
        <a class="btn sm" href="${shareUrl(sh.token)}" target="_blank" rel="noopener">Abrir</a>
        <button class="btn sm danger" type="button" data-sh-act="off">Desativar</button>`}
    </div>`).join("") : `<p class="muted" style="margin:0;font-size:.88rem">Nenhum link ainda. Use “🔗 Compartilhar” numa dúvida ou “Compartilhar várias” na biblioteca.</p>`;
}

function renderTags() {
  $("#tag-admin").innerHTML = S.tags.map(t => `<span>${esc(t.name)}<button class="x" type="button" data-del-tag="${t.id}" aria-label="Remover ${esc(t.name)}">×</button></span>`).join("")
    || `<p class="empty">Nenhum spot.</p>`;
}
function fillStaticSelects() {
  const siteOpts = SITES.map(s => `<option>${esc(s)}</option>`).join("");
  $("#f-site").innerHTML = `<option value="">Todas as salas</option>` + siteOpts;
  $("#h-site").innerHTML = `<option value="">—</option>` + siteOpts;
  $("#h-pos").innerHTML = `<option value="">—</option>` + POSITIONS.map(p => `<option>${p}</option>`).join("");
}

/* ================= tela da dúvida ================= */
let backTo = "maos";          // de onde veio (biblioteca ou plantão)
let navIds = null;            // a lista em que você estava quando abriu a dúvida (fica fixa enquanto navega)
let showIdx = null;           // qual print está em destaque
const CM = { text: "", files: [] }; // rascunho do comentário
const fmtWhen = iso => { const d = new Date(iso); return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); };

function currentListIds() {
  return (backTo === "plantao" ? libraryItems().filter(x => x.d.plantao) : filteredItems()).filter(x => x.d.id).map(x => x.d.id);
}
function doubtNav(d) {
  // usa a lista fixada no momento em que você abriu a dúvida; assim resolver/reabrir não tira a dúvida da navegação
  let ids = navIds && navIds.includes(d.id) ? navIds.filter(id => S.decisions.some(x => x.id === id)) : currentListIds();
  if (!ids.includes(d.id)) ids = [d.id];
  const pos = ids.indexOf(d.id);
  const statusOf = id => S.decisions.find(x => x.id === id)?.status;
  return {
    pos, total: ids.length,
    prev: pos > 0 ? ids[pos - 1] : null,
    next: pos < ids.length - 1 ? ids[pos + 1] : null,
    // próxima da mesma "pilha": abertas → próxima aberta; resolvidas → próxima resolvida
    nextSame: status => ids.slice(pos + 1).find(id => statusOf(id) === status) || null
  };
}

function renderDoubt() {
  const el = $("#v-duvida");
  const d = S.decisions.find(x => x.id === currentDec);
  const backLbl = backTo === "plantao" ? "Plantão" : "Biblioteca";
  if (!d) {
    el.innerHTML = `<div class="dv-bar"><a class="btn sm" href="#${backTo}">← ${backLbl}</a></div><p class="empty">Essa dúvida não existe mais.</p>`;
    return;
  }
  const h = S.hands.find(x => x.id === d.hand_id) || {};
  const imgs = imagesOf(h.id);
  const myIdx = d.image_id ? imgs.findIndex(i => i.id === d.image_id) : -1;
  if (showIdx === null || showIdx >= imgs.length) showIdx = myIdx >= 0 ? myIdx : 0;
  const cur = imgs[showIdx];
  const nav = doubtNav(d);
  const decs = decisionsOf(h.id), n = decs.findIndex(x => x.id === d.id);
  const cms = commentsOf(d.id), pins = cms.filter(c => c.pinned);
  const resolved = d.status === "revisada";
  const leak = S.leaks.find(l => l.id === d.leak_id);
  const fact = (label, val, wide) => val ? `<div class="${wide ? "wide" : ""}"><dt>${label}</dt><dd>${val}</dd></div>` : "";

  el.innerHTML = `
    <div class="dv-bar">
      <a class="btn sm" href="#${backTo}">← ${backLbl}</a>
      <span class="spacer"></span>
      ${nav.pos >= 0 ? `<span class="muted num" style="font-size:.8rem">${nav.pos + 1} de ${nav.total}</span>` : ""}
      <button class="btn sm" type="button" data-go="${nav.prev || ""}" ${nav.prev ? "" : "disabled"}>‹ Anterior</button>
      <button class="btn sm" type="button" data-go="${nav.next || ""}" ${nav.next ? "" : "disabled"}>Próxima ›</button>
    </div>

    <div class="dv-title">
      <div class="meta">${streetTag(d.street)}
        <span class="st ${resolved ? "revisada" : "rever"}" style="margin-left:0">${resolved ? "resolvida" : "aberta"}</span>
        ${d.plantao ? `<span class="st pl">plantão</span>` : ""}
        ${decs.length > 1 ? `<span class="muted" style="font-size:.8rem">Dúvida ${n + 1} de ${decs.length} nesta mão</span>` : ""}
      </div>
      <h1>${esc(d.question || "Sem pergunta escrita")}</h1>
      ${d.situation ? `<p class="muted" style="margin:0">${esc(d.situation)}</p>` : ""}
      <div class="dv-actions">
        ${resolved
          ? `<button class="btn" type="button" data-act="toggle" title="Reabre esta dúvida e abre a próxima resolvida da lista">↺ Reabrir${nav.nextSame("revisada") ? " e ir para a próxima" : ""}</button>`
          : `<button class="btn primary" type="button" data-act="toggle" title="Marca como resolvida e abre a próxima aberta da lista">✓ Marcar como resolvida${nav.nextSame("rever") ? " e ir para a próxima" : ""}</button>`}
        <button class="btn" type="button" data-act="plantao" aria-pressed="${!!d.plantao}">${d.plantao ? "✓ No plantão" : "Levar pro plantão"}</button>
        ${imgs.length ? `<button class="btn" type="button" data-act="show">▶ Apresentar</button>` : ""}
        <button class="btn" type="button" data-act="share">🔗 Compartilhar</button>
        <button class="btn ghost" type="button" data-act="edit">Editar mão</button>
      </div>
    </div>

    <div class="dv-grid">
      <div style="min-width:0;display:flex;flex-direction:column;gap:16px">
        ${cur ? `<div>
          <div class="dv-stage"><img src="${esc(S.urls.get(cur.path) || "")}" alt="Print ${showIdx + 1}" data-stage>
            <div class="cap">Print ${showIdx + 1} de ${imgs.length}${showIdx === myIdx ? " · desta dúvida" : ""}${cur.caption ? " — " + esc(cur.caption) : ""}</div></div>
          ${imgs.length > 1 ? `<div class="dv-strip">${imgs.map((im, k) => `<button type="button" data-show="${k}" aria-current="${k === showIdx}" class="${k === myIdx ? "this" : ""}" title="${esc(im.caption || "")}"><img src="${esc(S.urls.get(im.path) || "")}" alt="Print ${k + 1}"><span>${k + 1}${im.caption ? " · " + esc(im.caption) : ""}</span></button>`).join("")}</div>` : ""}
        </div>` : `<p class="empty">Esta dúvida não tem print.</p>`}
        ${h.situation ? `<div class="card"><h2>Resumo da mão</h2><p class="dv-text">${esc(h.situation)}</p></div>` : ""}

        <div class="card">
          <div class="card-h"><h2>Discussão</h2><span class="muted" style="font-size:.8rem">${cms.length ? cms.length + (cms.length === 1 ? " comentário" : " comentários") : ""}</span></div>
          <div class="thread">
            ${cms.length ? cms.map(c => CE.id === c.id ? cmtEditor(c) : `
              <div class="cmt ${c.pinned ? "pinned" : ""}" data-cm="${c.id}">
                <div class="cmt-h">${c.pinned ? `<span class="pin-lbl">📌 Conclusão</span>` : ""}<span>${fmtWhen(c.created_at)}</span><span class="spacer"></span>
                  <button type="button" data-cm-act="pin">${c.pinned ? "Desafixar" : "Fixar como conclusão"}</button>
                  <button type="button" data-cm-act="edit">Editar</button>
                  <button type="button" data-cm-act="del">Excluir</button></div>
                ${c.body ? `<div class="cmt-body">${esc(c.body)}</div>` : ""}
                ${c.images?.length ? `<div class="cmt-imgs">${c.images.map(p => `<img src="${esc(S.urls.get(p) || "")}" alt="Print do comentário" data-zoom-cm>`).join("")}</div>` : ""}
              </div>`).join("") : `<p class="muted" style="margin:0;font-size:.88rem">Use este espaço para ir resolvendo a dúvida: anotações, o que o solver mostrou, a resposta do coach, prints de range. Quando chegar numa resposta, fixe como conclusão e marque como resolvida.</p>`}
          </div>
          <div class="composer" id="cm-box">
            <textarea id="cm-text" placeholder="Escreva um comentário. Cole prints com Ctrl+V ou arraste para cá.">${esc(CM.text)}</textarea>
            ${CM.files.length ? `<div class="pend">${CM.files.map((f, k) => `<div><img src="${f.url}" alt=""><button type="button" data-cm-rm="${k}" aria-label="Remover print">✕</button></div>`).join("")}</div>` : ""}
            <div class="row">
              <label class="btn ghost sm" style="cursor:pointer">📎 Anexar print<input type="file" id="cm-file" accept="image/*" multiple hidden></label>
              <button class="btn primary sm" type="button" id="cm-send">Enviar</button>
            </div>
          </div>
        </div>
      </div>

      <div class="dv-side">
        ${(d.conclusion || pins.length) ? `<div class="resolved-box"><h3>Conclusão</h3>
          ${d.conclusion ? `<p class="dv-text">${esc(d.conclusion)}</p>` : ""}
          ${pins.map(c => `${c.body ? `<p class="dv-text">${esc(c.body)}</p>` : ""}${c.images?.length ? `<div class="cmt-imgs">${c.images.map(p => `<img src="${esc(S.urls.get(p) || "")}" alt="" data-zoom-cm>`).join("")}</div>` : ""}`).join("")}
        </div>` : ""}
        ${d.plantao && d.plantao_answer ? `<div class="card"><h2>Resposta do plantão</h2><p class="dv-text">${esc(d.plantao_answer)}</p></div>` : ""}
        ${hrcPanel(h)}
        <div class="card">
          <h2>A mão</h2>
          <dl class="dv-facts" style="margin:0">
            ${fact("Cartas", esc(h.hero_cards || ""))}
            ${fact("Posição", esc(h.position || ""))}
            ${fact("Stack inicial", h.stack_bb != null ? esc(h.stack_bb) + " bb" : "")}
            ${fact("Data", h.played_on ? shortDate(h.played_on) : "")}
            ${fact("Sala", esc(h.site || ""))}
            ${fact("Board", esc(h.board || ""))}
            ${fact("Torneio", esc(h.tournament || ""), true)}
            ${d.tags?.length ? `<div class="wide"><dt>Spots</dt><dd><div class="tags" style="margin-top:4px">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div></dd></div>` : ""}
            ${leak ? fact("Leak", esc(leak.title), true) : ""}
          </dl>
        </div>
        ${decs.length > 1 ? `<div class="card"><h2>Outras dúvidas desta mão</h2>
          <div class="stack">${decs.map((x, k) => x.id === d.id ? "" : `<button type="button" class="btn ghost" style="justify-content:flex-start;white-space:normal;text-align:left" data-go="${x.id}">${streetTag(x.street)} ${esc(x.question || "Dúvida " + (k + 1))}${x.status === "revisada" ? ` <span class="st revisada">resolvida</span>` : ""}</button>`).join("")}</div></div>` : ""}
      </div>
    </div>`;
}

// edição de comentário: texto, tirar prints e adicionar prints novos
const CE = { id: null, text: "", keep: [], files: [] };
function cmtEditor(c) {
  return `<div class="cmt editing ${c.pinned ? "pinned" : ""}" data-cm="${c.id}">
    <div class="cmt-h">${c.pinned ? `<span class="pin-lbl">📌 Conclusão</span>` : ""}<span>Editando</span></div>
    <textarea id="ce-text" rows="3">${esc(CE.text)}</textarea>
    ${CE.keep.length || CE.files.length ? `<div class="pend">
      ${CE.keep.map((p, k) => `<div><img src="${esc(S.urls.get(p) || "")}" alt=""><button type="button" data-ce-rm-old="${k}" aria-label="Tirar print">✕</button></div>`).join("")}
      ${CE.files.map((f, k) => `<div><img src="${f.url}" alt=""><button type="button" data-ce-rm-new="${k}" aria-label="Tirar print">✕</button></div>`).join("")}
    </div>` : ""}
    <div class="row">
      <label class="btn ghost sm" style="cursor:pointer">📎 Anexar print<input type="file" id="ce-file" accept="image/*" multiple hidden></label>
      <span class="muted" style="font-size:.75rem;flex:1">Ctrl+V cola print aqui · Ctrl+Enter salva</span>
      <button class="btn sm" type="button" data-cm-act="edit-cancel">Cancelar</button>
      <button class="btn sm primary" type="button" data-cm-act="edit-save">Salvar</button>
    </div>
  </div>`;
}
async function addEditFiles(files) {
  for (const f of [...files].filter(f => f && f.type && f.type.startsWith("image/"))) {
    const blob = await compress(f);
    CE.files.push({ blob, url: URL.createObjectURL(blob) });
  }
  renderDoubt(); $("#ce-text")?.focus();
}
function endEdit() { CE.files.forEach(f => URL.revokeObjectURL(f.url)); CE.id = null; CE.text = ""; CE.keep = []; CE.files = []; }

async function addCommentFiles(files) {
  for (const f of [...files].filter(f => f && f.type && f.type.startsWith("image/"))) {
    const blob = await compress(f);
    CM.files.push({ blob, url: URL.createObjectURL(blob) });
  }
  renderDoubt();
  $("#cm-text")?.focus();
}
async function setDecision(d, patch, what) {
  const r = await q(sb.from("decisions").update(patch).eq("id", d.id).select().single(), what);
  S.decisions = S.decisions.map(x => x.id === r.id ? r : x);
  return r;
}

$("#v-duvida").addEventListener("input", e => { if (e.target.id === "cm-text") CM.text = e.target.value; if (e.target.id === "ce-text") CE.text = e.target.value; });
$("#v-duvida").addEventListener("change", e => {
  if (e.target.id === "cm-file") { const f = [...e.target.files]; e.target.value = ""; addCommentFiles(f); }
  if (e.target.id === "ce-file") { const f = [...e.target.files]; e.target.value = ""; addEditFiles(f); }
  if (e.target.id === "lobby-file") { const f = e.target.files[0]; e.target.value = ""; if (f) uploadLobby(f); }
});
$("#v-duvida").addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); $("#cm-box")?.classList.add("over"); } });
$("#v-duvida").addEventListener("dragleave", e => { if (!e.currentTarget.contains(e.relatedTarget)) $("#cm-box")?.classList.remove("over"); });
$("#v-duvida").addEventListener("keydown", e => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  if (e.target.id === "cm-text") { e.preventDefault(); $("#cm-send")?.click(); }
  if (e.target.id === "ce-text") { e.preventDefault(); $("[data-cm-act=edit-save]")?.click(); }
});
$("#v-duvida").addEventListener("click", async e => {
  const t = e.target;
  const d = S.decisions.find(x => x.id === currentDec); if (!d) return;
  const go = t.closest("[data-go]"); if (go) { if (go.dataset.go) { CM.text = ""; endEdit(); location.hash = "duvida-" + go.dataset.go; } return; }
  const sh = t.closest("[data-show]"); if (sh) { showIdx = +sh.dataset.show; renderDoubt(); return; }
  if (t.closest("[data-stage]")) { openShow(d, showIdx); return; }
  const zc = t.closest("[data-zoom-cm]"); if (zc) { $("#viewer-img").src = zc.src; $("#dlg-view").showModal(); return; }
  const ro = t.closest("[data-ce-rm-old]"); if (ro) { CE.keep.splice(+ro.dataset.ceRmOld, 1); renderDoubt(); return; }
  const rn = t.closest("[data-ce-rm-new]"); if (rn) { const [f] = CE.files.splice(+rn.dataset.ceRmNew, 1); URL.revokeObjectURL(f.url); renderDoubt(); return; }
  const rmf = t.closest("[data-cm-rm]"); if (rmf) { const [f] = CM.files.splice(+rmf.dataset.cmRm, 1); URL.revokeObjectURL(f.url); renderDoubt(); return; }

  const hb = t.closest("[data-hrc]");
  if (hb) { hrcAction(hb.dataset.hrc, d); return; }
  const act = t.closest("[data-act]")?.dataset.act;
  try {
    if (act === "toggle") {
      const before = d.status === "revisada" ? "revisada" : "rever";
      const next = doubtNav(d).nextSame(before);
      await setDecision(d, { status: before === "revisada" ? "rever" : "revisada" }, "atualizar a dúvida");
      const what = before === "revisada" ? "Dúvida reaberta" : "Dúvida resolvida";
      if (next) { toast(what); CM.text = ""; location.hash = "duvida-" + next; }
      else { toast(what + ". Era a última da lista."); renderAll(); }
      return;
    }
    if (act === "plantao") { await setDecision(d, { plantao: !d.plantao }, "atualizar o plantão"); renderAll(); return; }
    if (act === "show") { openShow(d, showIdx); return; }
    if (act === "share") { shareDecisions([d.id], d.question || "Dúvida de poker"); return; }
    if (act === "edit") { openHand(d.hand_id, [], { focusDec: d.id }); return; }
  } catch { return; }

  if (t.id === "cm-send") {
    const body = ($("#cm-text").value || "").trim();
    if (!body && !CM.files.length) { $("#cm-text").focus(); return; }
    t.disabled = true; t.textContent = "Enviando…";
    try {
      const paths = [];
      for (const f of CM.files) {
        const path = `${S.user.id}/comments/${d.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        const { error } = await sb.storage.from("hands").upload(path, f.blob, { contentType: f.blob.type || "image/jpeg" });
        if (error) { fail(error, "enviar o print"); continue; }
        S.urls.set(path, f.url); paths.push(path);
      }
      const c = await q(sb.from("comments").insert({ decision_id: d.id, body: body || null, images: paths }).select().single(), "enviar o comentário");
      S.comments.push(c);
      CM.text = ""; CM.files = [];
      renderAll();
      setTimeout(() => $("#cm-text")?.focus(), 30);
    } catch { t.disabled = false; t.textContent = "Enviar"; }
    return;
  }

  const ca = t.closest("[data-cm-act]");
  if (ca) {
    const c = S.comments.find(x => x.id === ca.closest("[data-cm]").dataset.cm); if (!c) return;
    try {
      if (ca.dataset.cmAct === "edit") {
        endEdit(); CE.id = c.id; CE.text = c.body || ""; CE.keep = [...(c.images || [])];
        renderDoubt(); const ta = $("#ce-text"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }
      if (ca.dataset.cmAct === "edit-cancel") { endEdit(); renderDoubt(); return; }
      if (ca.dataset.cmAct === "edit-save") {
        const body = (CE.text || "").trim();
        if (!body && !CE.keep.length && !CE.files.length) { toast("O comentário ficaria vazio. Use Excluir se quiser apagar.", true); return; }
        ca.disabled = true; ca.textContent = "Salvando…";
        const added = [];
        for (const f of CE.files) {
          const path = `${S.user.id}/comments/${c.decision_id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
          const { error } = await sb.storage.from("hands").upload(path, f.blob, { contentType: f.blob.type || "image/jpeg" });
          if (error) { fail(error, "enviar o print"); continue; }
          S.urls.set(path, f.url); f.keepUrl = true; added.push(path);
        }
        const images = [...CE.keep, ...added];
        const r = await q(sb.from("comments").update({ body: body || null, images }).eq("id", c.id).select().single(), "salvar a edição");
        const removed = (c.images || []).filter(p => !images.includes(p));
        if (removed.length) await sb.storage.from("hands").remove(removed);
        S.comments = S.comments.map(x => x.id === r.id ? r : x);
        CE.files = CE.files.filter(f => !f.keepUrl); endEdit();
        toast("Comentário atualizado"); renderAll();
        return;
      }
      if (ca.dataset.cmAct === "pin") {
        const r = await q(sb.from("comments").update({ pinned: !c.pinned }).eq("id", c.id).select().single(), "fixar o comentário");
        S.comments = S.comments.map(x => x.id === r.id ? r : x); renderAll();
      } else if (ca.dataset.cmAct === "del") {
        if (!ca.hasAttribute("data-armed")) { ca.setAttribute("data-armed", ""); ca.textContent = "Confirmar"; return; }
        if (c.images?.length) await sb.storage.from("hands").remove(c.images);
        await q(sb.from("comments").delete().eq("id", c.id), "excluir o comentário");
        S.comments = S.comments.filter(x => x.id !== c.id); renderAll();
      }
    } catch { }
  }
});

/* ---- HRC: .json do torneio e mão no formato PokerStars ---- */
const HRC = { pasteLobby: false, busy: "", msg: {} };
function hrcPanel(h) {
  if (!h?.id) return "";
  const lobby = lobbyOf(h.id);
  const p = h.hrc_payouts, t = h.hrc_table;
  const chk = p ? checkPayouts(p) : null;
  const m = HRC.msg[h.id] || {};
  const busy = HRC.busy;
  let hh = null;
  if (t) { try { hh = buildPokerStarsHH(t, { handKey: h.id, date: h.played_on ? new Date(h.played_on + "T12:00:00") : new Date(), tournament: h.tournament || "", buyinOverride: p?.buyin_total, site: h.site || p?.site || "", fullBountySites: PKO_SHOWS_FULL_BOUNTY }); } catch (e) { hh = { error: e.message }; } }
  const warn = list => list?.length ? `<ul class="hrc-warn">${list.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
  return `<div class="card hrc">
    <div class="card-h"><h2>HRC</h2><span class="muted" style="font-size:.75rem">só usa IA quando você clica</span></div>
    <div class="hrc-lobby">
      ${lobby ? `<img src="${esc(S.urls.get(lobby.path) || "")}" alt="Print do lobby" data-zoom-cm>` : `<div class="hrc-nolobby">Sem print do lobby</div>`}
      <div class="stack" style="gap:6px">
        <label class="btn sm" style="cursor:pointer">📎 ${lobby ? "Trocar" : "Anexar"} lobby<input type="file" id="lobby-file" accept="image/*" hidden></label>
        <button class="btn sm ${HRC.pasteLobby ? "primary" : ""}" type="button" data-hrc="paste-lobby">${HRC.pasteLobby ? "Agora aperte Ctrl+V…" : "Colar lobby (Ctrl+V)"}</button>
      </div>
    </div>

    <div class="hrc-row">
      <button class="btn" type="button" data-hrc="json" ${lobby && !busy ? "" : "disabled"}>${busy === "json" ? "Lendo o lobby…" : "⬇ Baixar .json do torneio"}</button>
      ${p ? `<button class="linkish" type="button" data-hrc="json-redo" ${busy ? "disabled" : ""}>ler de novo</button>` : ""}
    </div>
    ${p ? `<p class="hint">${chk.lastPaid} posições pagas${p.places_paid ? ` (lobby: ${p.places_paid})` : ""}${p.players_left ? ` · ${p.players_left} restantes` : ""}${p.small_blind ? ` · nível ${p.small_blind}/${p.big_blind}${p.ante ? ` (${p.ante})` : ""}` : ""}</p>${warn(chk.problems)}` : ""}
    ${m.json ? `<p class="hint err">${esc(m.json)}</p>` : ""}

    <div class="hrc-row">
      <button class="btn" type="button" data-hrc="hh" ${imagesOf(h.id).length && !busy ? "" : "disabled"}>${busy === "hh" ? "Lendo a mesa…" : "📋 Copiar mão para o HRC"}</button>
      ${t ? `<button class="linkish" type="button" data-hrc="hh-redo" ${busy ? "disabled" : ""}>ler de novo</button>` : ""}
    </div>
    ${hh?.error ? `<p class="hint err">${esc(hh.error)}</p>` : ""}
    ${hh?.text ? `${warn(hh.warnings)}<details><summary>Ver o histórico gerado (${hh.summary.players} jogadores · ${hh.summary.sb}/${hh.summary.bb} · ante ${hh.summary.ante}${hh.summary.bountyMult === 2 ? " · bounty da mesa ×2 = total" : ""})</summary><textarea class="hh-text" id="hh-text" readonly rows="10">${esc(hh.text)}</textarea></details>` : ""}
    ${m.hh ? `<p class="hint ${m.hhOk ? "" : "err"}">${esc(m.hh)}</p>` : ""}
    <p class="hint">No HRC: abra o .json na configuração da mão e cole o histórico (formato PokerStars). Stacks, posições, blinds, ante e bounties entram juntos.</p>
  </div>`;
}

async function callHRC(body) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch("/api/hrc", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (session?.access_token || "") }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 503) throw new Error("falta a chave da IA na Vercel");
  if (r.status === 404) throw new Error("a função do HRC ainda não foi publicada");
  if (!r.ok) throw new Error(j.detail || j.error || "HTTP " + r.status);
  return j;
}
async function imgB64(img, max = 1800) {
  const url = S.urls.get(img.path);
  const blob = await (await fetch(url)).blob();
  return toBase64(await compress(blob, max, 0.9));
}
async function saveHand(h, patch, what) {
  const r = await q(sb.from("hands").update(patch).eq("id", h.id).select().single(), what);
  S.hands = S.hands.map(x => x.id === r.id ? r : x);
  return r;
}
async function uploadLobby(file) {
  const d = S.decisions.find(x => x.id === currentDec); if (!d || !file) return;
  const h = S.hands.find(x => x.id === d.hand_id); if (!h) return;
  try {
    const blob = await compress(file, 2400, 0.92); // lobby tem texto pequeno: guarda maior
    const path = `${S.user.id}/${h.id}/lobby-${Date.now()}.jpg`;
    const { error } = await sb.storage.from("hands").upload(path, blob, { contentType: "image/jpeg" });
    if (error) { fail(error, "enviar o lobby"); return; }
    const img = await q(sb.from("hand_images").insert({ hand_id: h.id, path, sort: 999, caption: "lobby", kind: "lobby" }).select().single(), "registrar o lobby");
    S.images.push(img); S.urls.set(path, URL.createObjectURL(blob));
    if (h.hrc_payouts) await saveHand(h, { hrc_payouts: null }, "limpar a premiação antiga");
    toast("Lobby anexado"); renderDoubt();
  } catch { }
}
function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function hrcAction(kind, d) {
  let h = S.hands.find(x => x.id === d.hand_id); if (!h) return;
  HRC.msg[h.id] = HRC.msg[h.id] || {};
  const m = HRC.msg[h.id];
  if (kind === "paste-lobby") { HRC.pasteLobby = !HRC.pasteLobby; renderDoubt(); return; }

  if (kind === "json" || kind === "json-redo") {
    const lobby = lobbyOf(h.id); if (!lobby) return;
    m.json = "";
    try {
      if (!h.hrc_payouts || kind === "json-redo") {
        HRC.busy = "json"; renderDoubt();
        const p = await callHRC({ mode: "payouts", images: [await imgB64(lobby, 2400)] });
        if (!p.payouts?.length) throw new Error("não achei a tabela de premiação no print do lobby");
        h = await saveHand(h, { hrc_payouts: p }, "salvar a premiação");
      }
      const p = h.hrc_payouts;
      const safe = String(p.tournament || h.tournament || "torneio").replace(/[^\w$ -]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "torneio";
      downloadJson(buildPayoutsJson(p, { handKey: h.id, site: h.site }), `${safe}.json`);
      toast(".json baixado");
    } catch (e) { m.json = "Não deu para montar o .json: " + (e.message || e); }
    HRC.busy = ""; renderDoubt(); return;
  }

  if (kind === "hh" || kind === "hh-redo") {
    m.hh = ""; m.hhOk = false;
    try {
      if (!h.hrc_table || kind === "hh-redo") {
        const first = imagesOf(h.id)[0]; if (!first) return;
        const lobby = lobbyOf(h.id);
        HRC.busy = "hh"; renderDoubt();
        const images = [await imgB64(first)], labels = ["Print da mesa (início da mão)"];
        if (lobby) { images.push(await imgB64(lobby, 2400)); labels.push("Print do lobby do torneio"); }
        const t = await callHRC({ mode: "table", images, labels });
        if (!t.players?.length) throw new Error("não achei os jogadores no print da mesa");
        h = await saveHand(h, { hrc_table: t }, "salvar a leitura da mesa");
      }
      const hh = buildPokerStarsHH(h.hrc_table, { handKey: h.id, date: h.played_on ? new Date(h.played_on + "T12:00:00") : new Date(), tournament: h.tournament || "", buyinOverride: h.hrc_payouts?.buyin_total, site: h.site || h.hrc_payouts?.site || "", fullBountySites: PKO_SHOWS_FULL_BOUNTY });
      try { await navigator.clipboard.writeText(hh.text); m.hh = "Copiado! Cole no HRC (importar histórico da área de transferência)."; m.hhOk = true; toast("Mão copiada para o HRC"); }
      catch { m.hh = "Mesa lida. Clique em “📋 Copiar mão para o HRC” de novo para copiar (o navegador só deixa copiar logo depois de um clique)."; m.hhOk = true; }
    } catch (e) { m.hh = "Não deu para montar a mão: " + (e.message || e); }
    HRC.busy = ""; renderDoubt(); return;
  }
}

/* ---- modo apresentar (para mostrar a mão ao coach) ---- */
const SH = { imgs: [], i: 0, d: null };
function openShow(d, start = 0) {
  SH.d = d; SH.imgs = imagesOf(d.hand_id); SH.i = Math.max(0, Math.min(start || 0, SH.imgs.length - 1));
  if (!SH.imgs.length) return;
  renderShow(); $("#dlg-show").showModal();
}
function renderShow() {
  const im = SH.imgs[SH.i]; if (!im) return;
  const decHere = decisionsOf(SH.d.hand_id).find(x => x.image_id === im.id);
  $("#show-img").src = S.urls.get(im.path) || "";
  $("#show-pos").textContent = `${SH.i + 1} / ${SH.imgs.length}`;
  $("#show-cap").textContent = im.caption || "";
  $("#show-q").textContent = decHere?.question ? "❓ " + decHere.question : "";
  $("#show-q").hidden = !decHere?.question;
  $("#show-prev").disabled = SH.i === 0;
  $("#show-next").disabled = SH.i >= SH.imgs.length - 1;
}
$("#dlg-view").addEventListener("click", e => { if (!e.target.closest("img, [data-close]")) $("#dlg-view").close(); });
$("#dlg-show").addEventListener("click", e => { if (e.target.classList.contains("show-stage") || e.target.classList.contains("show-q")) $("#dlg-show").close(); });
$("#show-prev").addEventListener("click", () => { if (SH.i > 0) { SH.i--; renderShow(); } });
$("#show-next").addEventListener("click", () => { if (SH.i < SH.imgs.length - 1) { SH.i++; renderShow(); } });
document.addEventListener("keydown", e => {
  if (!$("#dlg-show").open) return;
  if (e.key === "ArrowLeft") $("#show-prev").click();
  if (e.key === "ArrowRight") $("#show-next").click();
});

/* ================= delete confirm ================= */
function armDelete(btn, label, onConfirm) {
  btn.removeAttribute("data-armed"); btn.textContent = label;
  btn.onclick = () => {
    if (btn.hasAttribute("data-armed")) { onConfirm(); return; }
    btn.setAttribute("data-armed", ""); btn.textContent = "Confirmar exclusão";
  };
}
/* ---- janelas: clicar fora ou Esc fecham; se houver algo não salvo, pergunta antes ---- */
const dirtyChecks = new Map(); // id da janela -> () => tem alterações não salvas?
function requestClose(dlg) {
  const check = dirtyChecks.get(dlg.id);
  if (check && check()) { showUnsaved(dlg); return; }
  dlg.close();
}
function showUnsaved(dlg) {
  let bar = dlg.querySelector(".unsaved");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "unsaved"; bar.setAttribute("role", "alert");
    bar.innerHTML = `<span>Você tem alterações não salvas.</span><button type="button" class="btn sm danger" data-unsaved="discard">Descartar</button><button type="button" class="btn sm primary" data-unsaved="stay">Continuar editando</button>`;
    (dlg.querySelector("form") || dlg).prepend(bar);
    bar.addEventListener("click", e => {
      const a = e.target.closest("[data-unsaved]")?.dataset.unsaved; if (!a) return;
      bar.hidden = true;
      if (a === "discard") dlg.close();
    });
  }
  bar.hidden = false;
  bar.querySelector("[data-unsaved=stay]").focus();
}
$$("dialog").forEach(dlg => {
  let downOutside = false;
  const outside = e => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  // só fecha se o clique começou E terminou fora (arrastar uma seleção de texto para fora não fecha)
  dlg.addEventListener("pointerdown", e => { downOutside = e.target === dlg && outside(e); });
  dlg.addEventListener("click", e => { if (downOutside && e.target === dlg && outside(e)) requestClose(dlg); downOutside = false; });
  dlg.addEventListener("cancel", e => { e.preventDefault(); requestClose(dlg); });
  dlg.addEventListener("close", () => { const bar = dlg.querySelector(".unsaved"); if (bar) bar.hidden = true; });
});
$$("dialog [data-close]").forEach(b => b.addEventListener("click", () => requestClose(b.closest("dialog"))));

/* ================= editor da mão ================= */
// imgs: [{key, id?, path?, url, caption, origCaption, blob?, removed}]
// decs: [{key, id?, imgKey, street, situation, question, tags, conclusion, status, plantao, plantao_answer, leak_id, ai, dirty}]
const H = { hand: null, imgs: [], decs: [], removedDecIds: [], aiRuns: 0, lobby: null, pasteLobby: false };
const dlgHand = $("#dlg-hand");
let keySeq = 0;
const newKey = () => "k" + (++keySeq);
const visibleImgs = () => H.imgs.filter(i => !i.removed);

function blankDec(extra = {}) {
  return { key: newKey(), id: null, imgKey: null, street: null, situation: "", question: "", tags: [], conclusion: "", status: "rever", plantao: false, plantao_answer: "", leak_id: null, ai: false, dirty: false, ...extra };
}

function openHand(id, files = [], opts = {}) {
  const h = id ? S.hands.find(x => x.id === id) : null;
  aiSeq++; clearTimeout(aiTimer);
  H.hand = h; H.removedDecIds = []; H.aiRuns = 0;
  H.imgs = h ? imagesOf(h.id).map(i => ({ key: "s:" + i.id, id: i.id, path: i.path, url: S.urls.get(i.path) || "", caption: i.caption || "", origCaption: i.caption || "", removed: false })) : [];
  H.decs = h ? decisionsOf(h.id).map(d => ({
    key: newKey(), id: d.id, imgKey: d.image_id ? "s:" + d.image_id : null, street: d.street, situation: d.situation || "", question: d.question || "",
    tags: [...(d.tags || [])], conclusion: d.conclusion || "", status: d.status === "revisada" ? "revisada" : "rever",
    plantao: !!d.plantao, plantao_answer: d.plantao_answer || "", leak_id: d.leak_id, ai: false, dirty: false
  })) : [];
  if (opts.doubt) H.decs.push(blankDec({ plantao: true, dirty: true }));
  const lb = h ? lobbyOf(h.id) : null;
  H.lobby = lb ? { id: lb.id, path: lb.path, url: S.urls.get(lb.path) || "" } : null;
  H.pasteLobby = false;

  $("#h-head").textContent = h ? (isInbox(h) ? "Mão da caixa de entrada" : "Mão") : (opts.doubt ? "Nova dúvida" : "Nova mão");
  $("#h-date").value = h?.played_on || today();
  $("#h-site").value = h?.site || "";
  $("#h-tour").value = h?.tournament || "";
  $("#h-cards").value = h?.hero_cards || "";
  $("#h-pos").value = h?.position || "";
  $("#h-stack").value = h?.stack_bb ?? "";
  $("#h-board").value = h?.board || "";
  $("#h-sit").value = h?.situation || "";
  $$("#f-hand .ai-filled").forEach(el => el.classList.remove("ai-filled"));
  $("#h-del").hidden = !h;
  if (h) armDelete($("#h-del"), "Excluir mão", deleteHand);
  aiMsg(aiOff ? "Leitura com IA desativada (falta a chave da IA na Vercel)." : "Cole os prints e escreva as legendas. A IA só lê quando você clicar em “Ler com IA”; se preferir, preencha à mão.", aiOff ? "warn" : "");
  renderGallery(); renderDecs(); renderLobbySlot();
  handSnap = handSig();
  if (!dlgHand.open) dlgHand.showModal();
  if (files.length) addFiles(files);
  if (opts.focusDec) {
    const i = H.decs.findIndex(d => d.id === opts.focusDec);
    setTimeout(() => { const el = $$("#h-decs .dec")[i]; if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); } }, 60);
  } else if (opts.doubt) setTimeout(() => $("#h-decs textarea[data-f=question]")?.focus(), 60);
}

let handSnap = "";
function handSig() {
  const f = ["#h-date", "#h-site", "#h-tour", "#h-cards", "#h-pos", "#h-stack", "#h-board", "#h-sit"].map(sel => $(sel).value);
  return JSON.stringify([f,
    H.imgs.map(i => [i.key, i.caption, !!i.removed]),
    H.decs.map(d => [d.key, d.imgKey, d.street, d.situation, d.question, d.tags, d.conclusion, d.status, d.plantao, d.plantao_answer, d.leak_id]),
    H.lobby ? [H.lobby.url, !!H.lobby.removed] : null, H.removedDecIds]);
}
dirtyChecks.set("dlg-hand", () => handSig() !== handSnap);

/* ---- imagens ---- */
async function compress(blob, max = 2000, quality = 0.9) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const out = await new Promise(r => c.toBlob(r, "image/jpeg", quality));
    return out || blob;
  } catch { return blob; }
}
const toBase64 = blob => new Promise((ok, no) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(blob);
});
async function addFiles(files) {
  const imgs = [...files].filter(f => f && f.type && f.type.startsWith("image/"));
  if (!imgs.length) return;
  for (const f of imgs) {
    const blob = await compress(f);
    H.imgs.push({ key: newKey(), id: null, url: URL.createObjectURL(blob), blob, caption: "", origCaption: "", removed: false });
  }
  renderGallery(); renderDecs();
  inputsChanged();
  // foca a legenda do último print colado
  setTimeout(() => { const caps = $$("#h-gallery input[data-cap]"); caps[caps.length - 1]?.focus(); }, 30);
}
function renderGallery() {
  const vis = visibleImgs();
  $("#h-gallery").innerHTML = vis.map((im, n) => `
    <div class="gcell">
      <div class="gimg"><img src="${esc(im.url)}" alt="Print ${n + 1}" data-zoom>${im.id ? "" : `<span class="new">novo</span>`}<span class="idx">${n + 1}</span><button type="button" class="rm" data-rm-img="${im.key}" aria-label="Remover print ${n + 1}">✕</button></div>
      <input type="text" data-cap="${im.key}" value="${esc(im.caption)}" placeholder="Legenda do print ${n + 1} (ex.: call?)" aria-label="Legenda do print ${n + 1}">
    </div>`).join("");
  $("#h-ai-run").hidden = !vis.length;
}
$("#h-gallery").addEventListener("input", e => {
  const k = e.target.dataset.cap; if (!k) return;
  const im = H.imgs.find(i => i.key === k); if (im) im.caption = e.target.value;
  inputsChanged();
});
$("#h-gallery").addEventListener("click", e => {
  const rm = e.target.closest("[data-rm-img]"), z = e.target.closest("[data-zoom]");
  if (rm) {
    const im = H.imgs.find(i => i.key === rm.dataset.rmImg); if (!im) return;
    if (im.id) im.removed = true; else { URL.revokeObjectURL(im.url); H.imgs = H.imgs.filter(i => i !== im); }
    H.decs.forEach(d => { if (d.imgKey === im.key) d.imgKey = null; });
    renderGallery(); renderDecs(); inputsChanged();
  } else if (z) { $("#viewer-img").src = z.src; $("#dlg-view").showModal(); }
});

/* ---- print do lobby (para o HRC, sem IA) ---- */
function renderLobbySlot() {
  const L = H.lobby, has = !!L?.url;
  const box = $("#h-lobby");
  box.className = "lobby-slot" + (H.pasteLobby ? " armed" : "");
  box.innerHTML = `
    ${L?.url ? `<img src="${esc(L.url)}" alt="Print do lobby" data-lobby-zoom>` : ""}
    <div class="txt"><b>Lobby do torneio</b> (opcional, para o HRC). ${H.pasteLobby ? "Agora aperte <kbd>Ctrl</kbd>+<kbd>V</kbd> para colar o lobby." : has ? "Anexado. Na página da dúvida você baixa o .json e copia a mão." : "Não passa pela IA agora: só é lido quando você clicar nos botões do HRC."}</div>
    <button class="btn sm ${H.pasteLobby ? "primary" : ""}" type="button" data-lobby-act="paste">${H.pasteLobby ? "Cancelar" : has ? "Trocar (Ctrl+V)" : "Colar lobby (Ctrl+V)"}</button>
    <label class="btn sm ghost" style="cursor:pointer">📎 Arquivo<input type="file" id="h-lobby-file" accept="image/*" hidden></label>
    ${has ? `<button class="btn sm ghost" type="button" data-lobby-act="remove">Remover</button>` : ""}`;
}
async function setEditorLobby(file) {
  if (!file || !file.type?.startsWith("image/")) return;
  H.pasteLobby = false;
  const blob = await compress(file, 2400, 0.92);
  if (H.lobby?.blob) URL.revokeObjectURL(H.lobby.url);
  H.lobby = { blob, url: URL.createObjectURL(blob), replaces: H.lobby?.id ? H.lobby : (H.lobby?.replaces || H.lobby?.removed || null) };
  renderLobbySlot(); toast("Lobby anexado");
}
$("#h-lobby").addEventListener("click", e => {
  const a = e.target.closest("[data-lobby-act]");
  if (a?.dataset.lobbyAct === "paste") { H.pasteLobby = !H.pasteLobby; renderLobbySlot(); return; }
  if (a?.dataset.lobbyAct === "remove") {
    const saved = H.lobby?.id ? H.lobby : H.lobby?.replaces || null; // o lobby que já estava salvo, se houver
    if (H.lobby?.blob) URL.revokeObjectURL(H.lobby.url);
    H.lobby = saved ? { removed: saved, url: "" } : null;
    renderLobbySlot(); return;
  }
  if (e.target.closest("[data-lobby-zoom]")) { $("#viewer-img").src = e.target.src; $("#dlg-view").showModal(); }
});
$("#h-lobby").addEventListener("change", e => { if (e.target.id === "h-lobby-file") { const f = e.target.files[0]; e.target.value = ""; setEditorLobby(f); } });

/* ---- dúvidas ---- */
function renderDecs() {
  const vis = visibleImgs();
  $("#h-dec-count").textContent = H.decs.length ? `(${H.decs.length})` : "";
  if (!H.decs.length) {
    $("#h-decs").innerHTML = `<p class="empty">${vis.length ? "A IA vai criar uma dúvida para cada print. Você também pode adicionar à mão em “+ Dúvida”." : "Nenhuma dúvida ainda."}</p>`;
    return;
  }
  const leakOpts = sel => `<option value="">Nenhum</option>` + S.leaks.map(l => `<option value="${l.id}" ${sel === l.id ? "selected" : ""}>${esc(l.title)}</option>`).join("");
  $("#h-decs").innerHTML = H.decs.map((d, n) => {
    const im = vis.find(i => i.key === d.imgKey);
    const printOpts = `<option value="">Sem print</option>` + vis.map((i, k) => `<option value="${i.key}" ${d.imgKey === i.key ? "selected" : ""}>Print ${k + 1}${i.caption ? " · " + esc(i.caption.slice(0, 28)) : ""}</option>`).join("");
    const streetOpts = `<option value="">Street</option>` + Object.entries(STREETS).map(([v, l]) => `<option value="${v}" ${d.street === v ? "selected" : ""}>${l}</option>`).join("");
    const sel = new Set(d.tags);
    const tagBtns = S.tags.length ? S.tags.map(t => `<button type="button" data-tag="${esc(t.name)}" aria-pressed="${sel.has(t.name)}" class="${d.ai && !d.dirty && sel.has(t.name) ? "ai-filled" : ""}">${esc(t.name)}</button>`).join("") : `<span class="muted" style="font-size:.85rem">Cadastre spots em Ajustes.</span>`;
    const aiCls = d.ai && !d.dirty ? "ai-filled" : "";
    return `<div class="dec" data-k="${d.key}">
      <div class="dleft">
        <div class="dthumb">${im ? `<img src="${esc(im.url)}" alt="" data-zoom>` : "sem print"}</div>
        <select data-f="imgKey" aria-label="Print da dúvida">${printOpts}</select>
        <select data-f="street" aria-label="Street">${streetOpts}</select>
      </div>
      <div class="dright">
        <div class="dtop"><b>Dúvida ${n + 1}</b>${d.ai && !d.dirty ? `<span class="tag" style="background:var(--violet-soft);color:var(--violet)">IA</span>` : ""}<button class="x" type="button" data-rm-dec aria-label="Remover dúvida ${n + 1}">×</button></div>
        <label>Pergunta<textarea data-f="question" rows="2" class="${aiCls}" placeholder="Ex.: Lead no river depois de X/C no flop e no turn?">${esc(d.question)}</textarea></label>
        <label>Momento<input type="text" data-f="situation" class="${aiCls}" value="${esc(d.situation)}" placeholder="Ex.: Turn, pote 15.6bb, vilão aposta 6.5bb"></label>
        <div><div class="lbl">Spots</div><div class="tag-pick">${tagBtns}</div></div>
        <label>Conclusão / o que o solver diz<textarea data-f="conclusion" rows="2" placeholder="Ex.: HRC prefere fold; AQ está no fundo do range de call">${esc(d.conclusion)}</textarea></label>
        <div class="drow">
          <label>Status<select data-f="status"><option value="rever" ${d.status !== "revisada" ? "selected" : ""}>Aberta</option><option value="revisada" ${d.status === "revisada" ? "selected" : ""}>Resolvida</option></select></label>
          <label>Leak<select data-f="leak_id">${leakOpts(d.leak_id)}</select></label>
          <label class="check"><input type="checkbox" data-f="plantao" ${d.plantao ? "checked" : ""}> Plantão</label>
        </div>
        ${d.plantao ? `<label>Resposta do plantão<textarea data-f="plantao_answer" rows="2" placeholder="O que o coach respondeu">${esc(d.plantao_answer)}</textarea></label>` : ""}
      </div>
    </div>`;
  }).join("");
}
const decOf = el => { const box = el.closest(".dec"); return box && H.decs.find(d => d.key === box.dataset.k); };
$("#h-decs").addEventListener("input", e => {
  const f = e.target.dataset.f, d = decOf(e.target); if (!f || !d) return;
  if (e.target.type === "checkbox") return;
  d[f] = e.target.value || (f === "imgKey" || f === "leak_id" || f === "street" ? null : "");
  d.dirty = true; e.target.classList.remove("ai-filled");
});
$("#h-decs").addEventListener("change", e => {
  const f = e.target.dataset.f, d = decOf(e.target); if (!f || !d) return;
  if (e.target.type === "checkbox") d[f] = e.target.checked;
  else d[f] = e.target.value || (f === "imgKey" || f === "leak_id" || f === "street" ? null : "");
  d.dirty = true;
  if (f === "plantao" || f === "imgKey") renderDecs();
});
$("#h-decs").addEventListener("click", e => {
  const d = decOf(e.target); if (!d) return;
  const tb = e.target.closest("[data-tag]");
  if (tb) {
    const t = tb.dataset.tag;
    d.tags = d.tags.includes(t) ? d.tags.filter(x => x !== t) : [...d.tags, t];
    d.dirty = true; tb.setAttribute("aria-pressed", d.tags.includes(t)); tb.classList.remove("ai-filled");
    return;
  }
  if (e.target.closest("[data-rm-dec]")) {
    if (d.id) H.removedDecIds.push(d.id);
    H.decs = H.decs.filter(x => x !== d); renderDecs(); return;
  }
  const z = e.target.closest("[data-zoom]");
  if (z) { $("#viewer-img").src = z.src; $("#dlg-view").showModal(); }
});
$("#h-dec-add").addEventListener("click", () => {
  H.decs.push(blankDec({ dirty: true })); renderDecs();
  setTimeout(() => { const qs = $$("#h-decs textarea[data-f=question]"); qs[qs.length - 1]?.focus(); }, 30);
});

$("#h-file").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; addFiles(f); });
const drop = $("#h-drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
dlgHand.addEventListener("close", () => {
  aiSeq++; clearTimeout(aiTimer);
  H.imgs.forEach(i => { if (i.blob && !i.keepUrl) URL.revokeObjectURL(i.url); });
  if (H.lobby?.blob && !H.lobby.keepUrl) URL.revokeObjectURL(H.lobby.url);
  H.lobby = null; H.pasteLobby = false;
  H.imgs = []; H.decs = [];
});
$("#f-hand").addEventListener("input", e => { if (!e.target.closest("#h-decs") && !e.target.dataset.cap) e.target.classList.remove("ai-filled"); });
$("#f-hand").addEventListener("change", e => { if (!e.target.closest("#h-decs")) e.target.classList.remove("ai-filled"); });

/* ================= leitura com IA ================= */
// Lê sozinha uma vez, quando você para de colar/digitar por alguns segundos.
// Depois disso, mudanças nos prints ou legendas só são relidas pelo botão (para não gastar à toa).
let aiTimer, aiOff = false, aiSeq = 0;
const AI_IDLE_MS = 3500;
function aiMsg(text, cls = "") { $("#h-ai-msg").textContent = text; $("#h-ai").className = "ai-bar " + cls; }
// A IA só roda quando você clica no botão (para não gastar à toa).
function inputsChanged() {
  if (aiOff || !visibleImgs().length) return;
  if (H.aiRuns > 0) aiMsg("Prints ou legendas mudaram. Clique em “Ler com IA” se quiser atualizar.", "");
}
async function runAI(manual) {
  clearTimeout(aiTimer);
  const seq = ++aiSeq;
  const vis = visibleImgs().filter(i => !isLobbyCaption(i.caption));
  if (!vis.length) { if (manual) aiMsg("Adicione um print primeiro."); return; }
  H.aiRuns++;
  aiMsg(`Lendo ${vis.length} print${vis.length > 1 ? "s" : ""} com IA…`, "busy"); $("#h-ai-run").disabled = true;
  try {
    const blobs = [];
    for (const im of vis.slice(0, 8)) {
      let b = im.blob;
      if (!b && im.url) { try { b = await (await fetch(im.url)).blob(); } catch { b = null; } }
      if (b) blobs.push(await compress(b, 1600, 0.85));
    }
    const images = await Promise.all(blobs.map(toBase64));
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify({ images, captions: vis.slice(0, 8).map(i => i.caption || ""), tags: S.tags.map(t => t.name), sites: SITES, positions: POSITIONS, heroNicks: HERO_NICKS })
    });
    const j = await r.json().catch(() => ({}));
    if (seq !== aiSeq || !dlgHand.open) return;
    if (r.status === 503 && j.error === "missing_key") { aiOff = true; aiMsg("Leitura automática desativada (falta a chave da IA na Vercel).", "warn"); return; }
    if (r.status === 404) { aiMsg("A função de IA ainda não está publicada.", "warn"); return; }
    if (!r.ok) throw new Error(j.detail || j.error || "HTTP " + r.status);
    applyAI(j, vis);
  } catch (e) {
    if (seq === aiSeq) aiMsg("Não deu para ler os prints: " + (e.message || e), "warn");
  } finally {
    if (seq === aiSeq) $("#h-ai-run").disabled = false;
  }
}
function applyAI(a, vis) {
  let n = 0;
  const put = (sel, val) => {
    const el = $(sel);
    if (val === null || val === undefined || String(val).trim() === "") return;
    if (el.value.trim() && !el.classList.contains("ai-filled")) return; // não mexe no que você editou
    el.value = String(val); el.classList.add("ai-filled"); n++;
  };
  if (a.site && SITES.includes(a.site)) put("#h-site", a.site);
  put("#h-tour", a.tournament);
  put("#h-cards", [a.hero_combo, a.hero_exact].filter(Boolean).join(" · "));
  if (a.position && POSITIONS.includes(a.position)) put("#h-pos", a.position);
  if (typeof a.stack_bb === "number") put("#h-stack", Math.round(a.stack_bb * 10) / 10);
  put("#h-board", a.board);
  put("#h-sit", a.summary);

  // troca as dúvidas que a IA criou antes (e que você não mexeu) pelas novas
  H.decs = H.decs.filter(d => !(d.ai && !d.dirty));
  const taken = new Set(H.decs.filter(d => d.imgKey).map(d => d.imgKey));
  const tagNames = new Set(S.tags.map(t => t.name));
  let added = 0;
  for (const x of (a.decisions || [])) {
    const imgKey = x.print ? vis[x.print - 1]?.key || null : null;
    if (imgKey && taken.has(imgKey)) continue; // você já tem uma dúvida sua nesse print
    H.decs.push(blankDec({ imgKey, street: x.street, situation: x.situation || "", question: x.question || "", tags: (x.tags || []).filter(t => tagNames.has(t)), ai: true }));
    added++;
  }
  // mantém a ordem dos prints
  const pos = new Map(vis.map((i, k) => [i.key, k]));
  H.decs.sort((p, q2) => (pos.has(p.imgKey) ? pos.get(p.imgKey) : 99) - (pos.has(q2.imgKey) ? pos.get(q2.imgKey) : 99));
  renderDecs();
  if (a.stop_reason === "max_tokens") { aiMsg(`A resposta da IA veio cortada (${added} dúvida${added === 1 ? "" : "s"}). Clique em “Ler com IA” de novo.`, "warn"); return; }
  aiMsg(n || added ? `Preenchido pela IA: ${added} dúvida${added === 1 ? "" : "s"}. Confira os campos em roxo antes de salvar.` : "A IA não encontrou nada novo para preencher.", "ok");
}
$("#h-ai-run").addEventListener("click", () => { aiOff = false; runAI(true); });

/* ---- salvar ---- */
$("#f-hand").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#h-save"); btn.disabled = true; btn.textContent = "Salvando…";
  const stack = $("#h-stack").value;
  const decs = H.decs.length ? H.decs : [blankDec()];
  const row = {
    played_on: $("#h-date").value || null, site: $("#h-site").value || null, tournament: $("#h-tour").value.trim() || null,
    hero_cards: $("#h-cards").value.trim() || null, position: $("#h-pos").value || null, stack_bb: stack === "" ? null : +stack,
    board: $("#h-board").value.trim() || null, situation: $("#h-sit").value.trim() || null,
    status: decs.every(d => d.status === "revisada") ? "revisada" : "rever",
    plantao: decs.some(d => d.plantao)
  };
  try {
    let hand;
    if (H.hand) {
      hand = await q(sb.from("hands").update(row).eq("id", H.hand.id).select().single(), "salvar a mão");
      S.hands = S.hands.map(x => x.id === hand.id ? hand : x);
    } else {
      hand = await q(sb.from("hands").insert(row).select().single(), "criar a mão");
      S.hands.unshift(hand);
    }

    // prints: remover, atualizar legenda/ordem, enviar novos
    const removed = H.imgs.filter(i => i.removed && i.id);
    if (removed.length) {
      await q(sb.from("hand_images").delete().in("id", removed.map(i => i.id)), "remover prints");
      await sb.storage.from("hands").remove(removed.map(i => i.path));
    }
    const keyToId = {};
    const vis = visibleImgs();
    for (let k = 0; k < vis.length; k++) {
      const im = vis[k];
      if (im.id) {
        keyToId[im.key] = im.id;
        const orig = S.images.find(x => x.id === im.id);
        if ((im.caption || "") !== (im.origCaption || "") || orig?.sort !== k) {
          await q(sb.from("hand_images").update({ caption: im.caption.trim() || null, sort: k }).eq("id", im.id), "salvar a legenda");
        }
      } else {
        const path = `${S.user.id}/${hand.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        const { error } = await sb.storage.from("hands").upload(path, im.blob, { contentType: im.blob.type || "image/jpeg", upsert: false });
        if (error) { fail(error, "enviar um print"); continue; }
        const saved = await q(sb.from("hand_images").insert({ hand_id: hand.id, path, sort: k, caption: im.caption.trim() || null, kind: isLobbyCaption(im.caption) ? "lobby" : "mesa" }).select().single(), "registrar o print");
        keyToId[im.key] = saved.id;
        S.urls.set(path, im.url); im.keepUrl = true; // usa a prévia local até recarregar
      }
    }

    // lobby
    const L = H.lobby;
    const oldLobby = L?.removed || L?.replaces || null;
    if (L?.blob) {
      const path = `${S.user.id}/${hand.id}/lobby-${Date.now()}.jpg`;
      const { error } = await sb.storage.from("hands").upload(path, L.blob, { contentType: "image/jpeg" });
      if (error) fail(error, "enviar o lobby");
      else {
        await q(sb.from("hand_images").insert({ hand_id: hand.id, path, sort: 999, caption: "lobby", kind: "lobby" }), "registrar o lobby");
        S.urls.set(path, L.url); L.keepUrl = true;
      }
    }
    if (oldLobby?.id && (L?.blob || L?.removed)) {
      await q(sb.from("hand_images").delete().eq("id", oldLobby.id), "remover o lobby antigo");
      await sb.storage.from("hands").remove([oldLobby.path]);
    }
    if ((L?.blob || L?.removed) && hand.hrc_payouts) {
      const r = await q(sb.from("hands").update({ hrc_payouts: null }).eq("id", hand.id).select().single(), "limpar a premiação antiga");
      S.hands = S.hands.map(x => x.id === r.id ? r : x);
    }

    // dúvidas
    if (H.removedDecIds.length) await q(sb.from("decisions").delete().in("id", H.removedDecIds), "remover dúvidas");
    const rows = decs.map((d, k) => ({
      id: d.id || uuid(), user_id: S.user.id, hand_id: hand.id, image_id: (d.imgKey && keyToId[d.imgKey]) || null, sort: k,
      street: d.street || null, situation: (d.situation || "").trim() || null, question: (d.question || "").trim() || null,
      tags: d.tags || [], conclusion: (d.conclusion || "").trim() || null, status: d.status === "revisada" ? "revisada" : "rever",
      plantao: !!d.plantao, plantao_answer: d.plantao ? ((d.plantao_answer || "").trim() || null) : null, leak_id: d.leak_id || null
    }));
    await q(sb.from("decisions").upsert(rows), "salvar as dúvidas");

    // recarrega só o que é desta mão
    const [imgs, ds] = await Promise.all([
      q(sb.from("hand_images").select("*").eq("hand_id", hand.id), "recarregar os prints"),
      q(sb.from("decisions").select("*").eq("hand_id", hand.id), "recarregar as dúvidas")
    ]);
    S.images = S.images.filter(i => i.hand_id !== hand.id).concat(imgs);
    S.decisions = S.decisions.filter(d => d.hand_id !== hand.id).concat(ds);
    await signImages(imgs.map(i => i.path));

    dlgHand.close();
    toast(`Mão salva com ${ds.length} dúvida${ds.length === 1 ? "" : "s"}`);
    renderAll();
  } catch { /* já avisado */ }
  finally { btn.disabled = false; btn.textContent = "Salvar"; }
});

async function deleteHand() {
  const h = H.hand; if (!h) return;
  try {
    const imgs = imagesOf(h.id);
    if (imgs.length) await sb.storage.from("hands").remove(imgs.map(i => i.path));
    await q(sb.from("hands").delete().eq("id", h.id), "excluir a mão");
    S.hands = S.hands.filter(x => x.id !== h.id);
    S.images = S.images.filter(i => i.hand_id !== h.id);
    const goneDecs = new Set(S.decisions.filter(d => d.hand_id === h.id).map(d => d.id));
    S.decisions = S.decisions.filter(d => d.hand_id !== h.id);
    S.comments = S.comments.filter(c => !goneDecs.has(c.decision_id));
    dlgHand.close(); toast("Mão excluída");
    if (view === "duvida") location.hash = backTo; else renderAll();
  } catch { /* já avisado */ }
}

/* ================= colar e arrastar em qualquer tela ================= */
document.addEventListener("paste", e => {
  if ($("#app").hidden) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  if (dlgHand.open && H.pasteLobby) { setEditorLobby(files[0]); }
  else if (dlgHand.open) { addFiles(files); toast("Print adicionado"); }
  else if (view === "duvida" && HRC.pasteLobby) { HRC.pasteLobby = false; uploadLobby(files[0]); }
  else if (view === "duvida" && CE.id) addEditFiles(files);
  else if (view === "duvida" && $("#cm-text")) addCommentFiles(files);
  else openHand(null, files);
});
let dragDepth = 0;
document.addEventListener("dragenter", e => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
document.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
document.addEventListener("drop", e => {
  dragDepth = 0; document.body.classList.remove("dragging");
  if (!e.dataTransfer?.files?.length || $("#app").hidden) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  if (dlgHand.open) addFiles(files);
  else if (view === "duvida" && CE.id) addEditFiles(files);
  else if (view === "duvida" && $("#cm-text")) addCommentFiles(files);
  else openHand(null, files);
});

/* ================= agenda ================= */
let editEv = null, eventSnap = "";
const eventSig = () => JSON.stringify(["#e-title", "#e-date", "#e-start", "#e-end", "#e-cat", "#e-note"].map(sel => $(sel).value));
dirtyChecks.set("dlg-event", () => eventSig() !== eventSnap);
function openEvent(id, day) {
  const e = id ? S.events.find(x => x.id === id) : null; editEv = e;
  $("#e-head").textContent = e ? "Editar evento" : "Novo evento";
  $("#e-title").value = e?.title || "";
  $("#e-date").value = e?.day || day || today();
  $("#e-start").value = e?.start_time || "";
  $("#e-end").value = e?.end_time || "";
  $("#e-cat").value = e?.category || "grind";
  $("#e-note").value = e?.note || "";
  $("#e-del").hidden = !e;
  if (e) armDelete($("#e-del"), "Excluir", async () => {
    try { await q(sb.from("events").delete().eq("id", e.id), "excluir o evento"); S.events = S.events.filter(x => x.id !== e.id); $("#dlg-event").close(); renderAll(); } catch { }
  });
  eventSnap = eventSig();
  $("#dlg-event").showModal();
}
$("#f-event").addEventListener("submit", async ev => {
  ev.preventDefault();
  const row = { title: $("#e-title").value.trim(), day: $("#e-date").value, start_time: $("#e-start").value || null, end_time: $("#e-end").value || null, category: $("#e-cat").value, note: $("#e-note").value.trim() || null };
  try {
    if (editEv) { const r = await q(sb.from("events").update(row).eq("id", editEv.id).select().single(), "salvar o evento"); S.events = S.events.map(x => x.id === r.id ? r : x); }
    else { const r = await q(sb.from("events").insert(row).select().single(), "criar o evento"); S.events.push(r); }
    $("#dlg-event").close(); renderAll();
  } catch { }
});

/* ================= cliques ================= */
document.addEventListener("click", async e => {
  const t = e.target;
  if (t.closest("dialog")) return;
  const ne = t.closest("[data-new-event]"); if (ne) { openEvent(null, ne.dataset.newEvent === "today" ? today() : ne.dataset.newEvent); return; }
  const ev = t.closest("[data-ev]"); if (ev) { openEvent(ev.dataset.ev); return; }
  const hd = t.closest("[data-hand]");
  if (hd) {
    if (SEL.on && view === "maos") {
      if (hd.dataset.dec) { SEL.ids.has(hd.dataset.dec) ? SEL.ids.delete(hd.dataset.dec) : SEL.ids.add(hd.dataset.dec); hd.classList.toggle("picked"); renderSelbar(); renderLibrary(); }
      return;
    }
    if (hd.dataset.dec) { backTo = view === "plantao" ? "plantao" : "maos"; navIds = currentListIds(); location.hash = "duvida-" + hd.dataset.dec; }
    else openHand(hd.dataset.hand);
    return;
  }

  const tk = t.closest("[data-task]");
  if (tk) {
    const k = S.tasks.find(x => x.id === tk.dataset.task); if (!k) return;
    try {
      if (t.closest("[data-del-task]")) { await q(sb.from("tasks").delete().eq("id", k.id), "excluir a tarefa"); S.tasks = S.tasks.filter(x => x.id !== k.id); }
      else if (t.matches("input[type=checkbox]")) {
        const r = await q(sb.from("tasks").update({ done: !k.done, done_on: !k.done ? today() : null }).eq("id", k.id).select().single(), "atualizar a tarefa");
        S.tasks = S.tasks.map(x => x.id === r.id ? r : x);
      } else return;
      renderAll();
    } catch { }
    return;
  }
  const pg = t.closest("[data-pg]");
  if (pg) {
    const p = S.pregrind.find(x => x.id === pg.dataset.pg); if (!p) return;
    try {
      if (t.closest("[data-del-pg]")) { await q(sb.from("pregrind").delete().eq("id", p.id), "excluir o lembrete"); S.pregrind = S.pregrind.filter(x => x.id !== p.id); }
      else if (t.matches("input[type=checkbox]")) { const r = await q(sb.from("pregrind").update({ done: !p.done }).eq("id", p.id).select().single(), "atualizar o lembrete"); S.pregrind = S.pregrind.map(x => x.id === r.id ? r : x); }
      else return;
      renderAll();
    } catch { }
    return;
  }
  const lk = t.closest("[data-leak]");
  if (lk) {
    const l = S.leaks.find(x => x.id === lk.dataset.leak); if (!l) return;
    if (t.closest("[data-leak-hands]")) {
      F.leak = l.id; F.status = "todas"; $$("#f-status button").forEach(x => x.setAttribute("aria-pressed", x.dataset.s === "todas"));
      location.hash = "maos"; return;
    }
    try {
      if (t.closest("[data-del-leak]")) { await q(sb.from("leaks").delete().eq("id", l.id), "excluir o leak"); S.leaks = S.leaks.filter(x => x.id !== l.id); S.decisions.forEach(d => { if (d.leak_id === l.id) d.leak_id = null; }); }
      else if (t.matches("input[type=checkbox]")) { const r = await q(sb.from("leaks").update({ status: l.status === "corrigido" ? "ativo" : "corrigido" }).eq("id", l.id).select().single(), "atualizar o leak"); S.leaks = S.leaks.map(x => x.id === r.id ? r : x); }
      else return;
      renderAll();
    } catch { }
    return;
  }
  const dt = t.closest("[data-del-tag]");
  if (dt) {
    try { await q(sb.from("tags").delete().eq("id", dt.dataset.delTag), "remover o spot"); S.tags = S.tags.filter(x => x.id !== dt.dataset.delTag); renderAll(); } catch { }
  }
});

/* ================= formulários ================= */
$("#task-form").addEventListener("submit", async e => {
  e.preventDefault();
  const text = $("#task-text").value.trim(); if (!text) return;
  try { const r = await q(sb.from("tasks").insert({ text, category: $("#task-cat").value }).select().single(), "criar a tarefa"); S.tasks.push(r); $("#task-text").value = ""; renderAll(); } catch { }
});
$("#clear-done").addEventListener("click", async () => {
  const ids = S.tasks.filter(k => k.done).map(k => k.id); if (!ids.length) return;
  try { await q(sb.from("tasks").delete().in("id", ids), "limpar tarefas"); S.tasks = S.tasks.filter(k => !k.done); renderAll(); } catch { }
});
$("#pg-form").addEventListener("submit", async e => {
  e.preventDefault();
  const text = $("#pg-text").value.trim(); if (!text) return;
  try { const r = await q(sb.from("pregrind").insert({ text }).select().single(), "criar o lembrete"); S.pregrind.push(r); $("#pg-text").value = ""; renderAll(); } catch { }
});
$("#pg-clear").addEventListener("click", async () => {
  const ids = S.pregrind.filter(p => p.done).map(p => p.id); if (!ids.length) return;
  try { await q(sb.from("pregrind").delete().in("id", ids), "limpar lembretes"); S.pregrind = S.pregrind.filter(p => !p.done); renderAll(); } catch { }
});
$("#leak-form").addEventListener("submit", async e => {
  e.preventDefault();
  const title = $("#leak-title").value.trim(); if (!title) return;
  try { const r = await q(sb.from("leaks").insert({ title, description: $("#leak-desc").value.trim() || null }).select().single(), "criar o leak"); S.leaks.push(r); $("#leak-title").value = ""; $("#leak-desc").value = ""; renderAll(); } catch { }
});
$("#tag-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#tag-name").value.trim(); if (!name) return;
  if (S.tags.some(t => t.name.toLowerCase() === name.toLowerCase())) { toast("Esse spot já existe", true); return; }
  try { const r = await q(sb.from("tags").insert({ name, sort: S.tags.length }).select().single(), "criar o spot"); S.tags.push(r); $("#tag-name").value = ""; renderAll(); } catch { }
});
$("#new-hand").addEventListener("click", () => openHand(null));
$("#new-doubt").addEventListener("click", () => openHand(null, [], { doubt: true }));
$("#wk-prev").addEventListener("click", () => { weekRef = addDays(weekRef, -7); renderAgenda(); });
$("#wk-next").addEventListener("click", () => { weekRef = addDays(weekRef, 7); renderAgenda(); });
$("#wk-today").addEventListener("click", () => { weekRef = weekStart(today()); renderAgenda(); });

// vira o dia sem precisar recarregar
let lastDay = today();
setInterval(() => { if (today() !== lastDay && S.user) { lastDay = today(); renderAll(); } }, 60000);

/* ================= caixa de entrada (prints do atalho do PC) ================= */
function renderInbox() {
  const hs = S.hands.filter(isInbox);
  $("#inbox-send-all").hidden = $("#inbox-del-all").hidden = !hs.length;
  $("#inbox-send-all").textContent = `Enviar ${hs.length > 1 ? "as " + hs.length : "a mão"} para a biblioteca`;
  const da = $("#inbox-del-all"); da.removeAttribute("data-armed"); da.textContent = hs.length > 1 ? `Descartar as ${hs.length}` : "Descartar";
  $("#inbox-grid").innerHTML = hs.length ? hs.map(h => {
    const imgs = imagesOf(h.id), first = imgs[0], url = first && S.urls.get(first.path);
    const when = new Date(h.created_at);
    const lb = lobbyOf(h.id);
    return `<div class="hand" data-inbox="${h.id}" role="button" tabindex="0">
      <div class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<span class="noimg">?</span>`}<span class="n">${imgs.length} print${imgs.length === 1 ? "" : "s"}${lb ? " + lobby" : ""}</span></div>
      <div class="body">
        <div class="top"><span class="st rever" style="margin-left:0">na caixa</span><span class="muted" style="font-size:.8rem">${dayTitle(iso(when))}, ${when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span></div>
        <div class="row" style="justify-content:space-between">
          <span class="muted" style="font-size:.84rem">Clique para legendar e salvar</span>
          <button class="btn sm danger" type="button" data-inbox-del>Descartar</button>
        </div>
      </div></div>`;
  }).join("") : `<p class="empty" style="grid-column:1/-1">Caixa vazia. Use <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> no PC para mandar prints para cá.</p>`;
}
$("#inbox-grid").addEventListener("click", async e => {
  const card = e.target.closest("[data-inbox]"); if (!card) return;
  const h = S.hands.find(x => x.id === card.dataset.inbox); if (!h) return;
  const del = e.target.closest("[data-inbox-del]");
  if (!del) { openHand(h.id); return; }
  if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "Confirmar"; return; }
  try {
    const paths = S.images.filter(i => i.hand_id === h.id).map(i => i.path);
    if (paths.length) await sb.storage.from("hands").remove(paths);
    await q(sb.from("hands").delete().eq("id", h.id), "descartar a mão");
    S.hands = S.hands.filter(x => x.id !== h.id);
    S.images = S.images.filter(i => i.hand_id !== h.id);
    toast("Mão descartada"); renderAll();
  } catch { }
});
$("#inbox-grid").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("[data-inbox]")) e.target.click(); });

// manda as mãos da caixa para a biblioteca: cada print vira uma dúvida (legenda = pergunta). Sem IA.
async function sendInboxToLibrary(hs) {
  if (!hs.length) return;
  const rows = [];
  for (const h of hs) {
    if (decisionsOf(h.id).length) continue;
    const imgs = imagesOf(h.id);
    const base = { user_id: S.user.id, hand_id: h.id, status: "rever", tags: [] };
    if (!imgs.length) rows.push({ ...base, id: uuid(), sort: 0 });
    imgs.forEach((im, k) => rows.push({ ...base, id: uuid(), image_id: im.id, sort: k, question: (im.caption || "").trim() || null }));
  }
  if (rows.length) await q(sb.from("decisions").insert(rows), "criar as dúvidas");
  const ids = hs.map(h => h.id);
  await q(sb.from("hands").update({ status: "rever" }).in("id", ids), "enviar para a biblioteca");
  S.decisions = S.decisions.concat(rows.map(r => ({ street: null, situation: null, question: null, conclusion: null, plantao: false, plantao_answer: null, leak_id: null, image_id: null, created_at: new Date().toISOString(), ...r })));
  S.hands = S.hands.map(h => ids.includes(h.id) ? { ...h, status: "rever" } : h);
}
$("#inbox-send-all").addEventListener("click", async e => {
  const hs = S.hands.filter(isInbox); if (!hs.length) return;
  const b = e.currentTarget; b.disabled = true; b.textContent = "Enviando…";
  try {
    await sendInboxToLibrary(hs);
    toast(`${hs.length} mã${hs.length === 1 ? "o enviada" : "os enviadas"} para a biblioteca`);
  } catch { }
  b.disabled = false; renderAll();
});
$("#inbox-del-all").addEventListener("click", async e => {
  const b = e.currentTarget, hs = S.hands.filter(isInbox); if (!hs.length) return;
  if (!b.hasAttribute("data-armed")) { b.setAttribute("data-armed", ""); b.textContent = `Confirmar: apagar ${hs.length} mã${hs.length === 1 ? "o" : "os"}`; return; }
  b.disabled = true;
  try {
    const ids = hs.map(h => h.id);
    const paths = S.images.filter(i => ids.includes(i.hand_id)).map(i => i.path);
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from("hands").remove(paths.slice(i, i + 100));
    await q(sb.from("hands").delete().in("id", ids), "descartar as mãos");
    S.hands = S.hands.filter(h => !ids.includes(h.id));
    S.images = S.images.filter(i => !ids.includes(i.hand_id));
    toast("Caixa de entrada limpa");
  } catch { }
  b.disabled = false; renderAll();
});

/* ================= compartilhar (link de leitura) ================= */
const SEL = { on: false, ids: new Set() };
const shareUrl = token => `${location.origin}/c/${token}`;
function newToken() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(22));
  return [...b].map(x => abc[x % abc.length]).join("");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
// copia o link primeiro (o navegador só deixa copiar logo depois do clique) e salva em seguida
async function shareDecisions(ids, title) {
  ids = ids.filter(Boolean);
  if (!ids.length) return false;
  const token = newToken(), url = shareUrl(token);
  const copied = await copyText(url);
  try {
    const r = await q(sb.from("shares").insert({ token, title: (title || "").trim().slice(0, 140) || null, decision_ids: ids }).select().single(), "criar o link (rodou o SQL 006?)");
    S.shares.unshift(r); renderShares();
    toast(copied ? `Link copiado! Cole no grupo. (${ids.length} dúvida${ids.length === 1 ? "" : "s"})` : `Link criado. Copie em Ajustes → Links compartilhados.`);
    return true;
  } catch { return false; }
}
function renderSelbar() {
  document.body.classList.toggle("selecting", SEL.on && view === "maos");
  $("#selbar").hidden = !(SEL.on && view === "maos");
  $("#sel-count").textContent = `${SEL.ids.size} selecionada${SEL.ids.size === 1 ? "" : "s"}`;
  $("#sel-share").disabled = !SEL.ids.size;
  $("#sel-toggle").textContent = SEL.on ? "✓ Selecionando…" : "🔗 Compartilhar várias";
  $("#sel-toggle").classList.toggle("primary", SEL.on);
}
function stopSelecting() { SEL.on = false; SEL.ids.clear(); $("#sel-title").value = ""; renderSelbar(); renderLibrary(); }
$("#sel-toggle").addEventListener("click", () => {
  if (SEL.on) { stopSelecting(); return; }
  SEL.on = true; SEL.ids.clear(); // começa sem nada marcado
  renderSelbar(); renderLibrary();
  toast("Clique nos cards (ou em “selecionar o dia”) para marcar");
});
$("#sel-cancel").addEventListener("click", stopSelecting);
$("#sel-share").addEventListener("click", async () => {
  // mantém a ordem da tela
  const order = filteredItems().map(x => x.d.id).filter(id => SEL.ids.has(id));
  const rest = [...SEL.ids].filter(id => !order.includes(id));
  const ids = [...order, ...rest];
  const title = $("#sel-title").value.trim() || `Estudo de ${shortDate(today())} · ${ids.length} dúvida${ids.length === 1 ? "" : "s"}`;
  if (await shareDecisions(ids, title)) stopSelecting();
});
window.addEventListener("hashchange", () => { if (SEL.on && location.hash !== "#maos") stopSelecting(); });
document.addEventListener("click", async e => {
  const a = e.target.closest("[data-sh-act]"); if (!a) return;
  const sh = S.shares.find(x => x.id === a.closest("[data-share]").dataset.share); if (!sh) return;
  if (a.dataset.shAct === "copy") { toast(await copyText(shareUrl(sh.token)) ? "Link copiado" : shareUrl(sh.token)); return; }
  if (a.dataset.shAct === "off" && !a.hasAttribute("data-armed")) { a.setAttribute("data-armed", ""); a.textContent = "Confirmar"; return; }
  try {
    const r = await q(sb.from("shares").update({ revoked: a.dataset.shAct === "off" }).eq("id", sh.id).select().single(), "atualizar o link");
    S.shares = S.shares.map(x => x.id === r.id ? r : x); renderShares();
    toast(r.revoked ? "Link desativado" : "Link reativado");
  } catch { }
});

// busca prints novos enviados pelo PC: ao voltar para a aba, ao abrir a caixa e a cada 20s com ela aberta
let inboxBusy = false;
async function refreshInbox() {
  if (!S.user || inboxBusy) return;
  inboxBusy = true;
  try {
    const { data: hs, error } = await sb.from("hands").select("*").eq("status", "inbox").order("created_at", { ascending: false });
    if (error) return;
    const ids = hs.map(h => h.id);
    let imgs = [];
    if (ids.length) {
      const r = await sb.from("hand_images").select("*").in("hand_id", ids).order("sort");
      if (r.error) return;
      imgs = r.data;
    }
    const before = JSON.stringify([S.hands.filter(isInbox).map(h => h.id), S.images.filter(i => ids.includes(i.hand_id)).map(i => i.id)]);
    const known = new Set(S.hands.map(h => h.id));
    // não mexe na mão que está aberta no editor
    const editing = dlgHand.open ? H.hand?.id : null;
    S.hands = S.hands.filter(h => !isInbox(h) || ids.includes(h.id) || h.id === editing);
    for (const h of hs) { if (h.id === editing) continue; if (known.has(h.id)) S.hands = S.hands.map(x => x.id === h.id ? h : x); else S.hands.unshift(h); }
    S.hands.sort((a, b) => b.created_at.localeCompare(a.created_at));
    S.images = S.images.filter(i => !ids.includes(i.hand_id) || i.hand_id === editing).concat(imgs.filter(i => i.hand_id !== editing));
    await signImages(imgs.map(i => i.path));
    const after = JSON.stringify([S.hands.filter(isInbox).map(h => h.id), S.images.filter(i => ids.includes(i.hand_id)).map(i => i.id)]);
    if (before !== after) renderAll();
  } finally { inboxBusy = false; }
}
$("#inbox-refresh").addEventListener("click", () => refreshInbox().then(() => toast("Caixa atualizada")));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshInbox(); });
window.addEventListener("focus", () => refreshInbox());
window.addEventListener("hashchange", () => { if (location.hash === "#entrada") refreshInbox(); });
setInterval(() => { if (!document.hidden && view === "entrada") refreshInbox(); }, 20000);

boot();
