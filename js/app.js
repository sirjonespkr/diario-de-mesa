import { SUPABASE_URL, SUPABASE_ANON_KEY, SITES, POSITIONS, DEFAULT_TAGS, HERO_NICKS } from "./config.js";

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
const DOW = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const CATS = { grind: ["Grind", "♠"], estudo: ["Estudo", "♦"], plantao: ["Plantão", "?"], pessoal: ["Pessoal", "♥"], outro: ["Outro", "♣"] };
const cat = c => CATS[c] ? c : "outro";
const suit = c => `<span class="suit c-${cat(c)}" title="${CATS[cat(c)][0]}">${CATS[cat(c)][1]}</span>`;

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

const S = { user: null, hands: [], images: [], events: [], tasks: [], pregrind: [], leaks: [], tags: [], urls: new Map() };

async function q(promise, what) {
  const { data, error } = await promise;
  if (error) { fail(error, what); throw error; }
  return data;
}

async function loadAll() {
  const [hands, images, events, tasks, pregrind, leaks, tags] = await Promise.all([
    q(sb.from("hands").select("*").order("created_at", { ascending: false }), "carregar as mãos"),
    q(sb.from("hand_images").select("*").order("sort"), "carregar os prints"),
    q(sb.from("events").select("*"), "carregar a agenda"),
    q(sb.from("tasks").select("*").order("created_at"), "carregar as tarefas"),
    q(sb.from("pregrind").select("*").order("created_at"), "carregar o pré-grind"),
    q(sb.from("leaks").select("*").order("created_at"), "carregar os leaks"),
    q(sb.from("tags").select("*").order("sort"), "carregar os spots")
  ]);
  Object.assign(S, { hands, images, events, tasks, pregrind, leaks, tags });
  if (!tags.length) {
    // upsert ignorando duplicados: seguro mesmo se duas abas tentarem criar ao mesmo tempo
    const rows = DEFAULT_TAGS.map((name, i) => ({ user_id: S.user.id, name, sort: i }));
    const { error } = await sb.from("tags").upsert(rows, { onConflict: "user_id,name", ignoreDuplicates: true });
    if (error) console.error(error);
    S.tags = await q(sb.from("tags").select("*").order("sort"), "carregar os spots");
  }
  await signImages(images.map(i => i.path));
}

async function signImages(paths) {
  const missing = paths.filter(p => !S.urls.has(p));
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await sb.storage.from("hands").createSignedUrls(missing.slice(i, i + 100), 60 * 60 * 12);
    if (error) { console.error(error); continue; }
    data.forEach(d => { if (d.signedUrl) S.urls.set(d.path, d.signedUrl); });
  }
}
const imagesOf = id => S.images.filter(i => i.hand_id === id).sort((a, b) => a.sort - b.sort);

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
const VIEWS = ["hoje", "agenda", "pregrind", "maos", "plantao", "leaks", "ajustes"];
let view = "hoje";
function route() {
  view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "hoje";
  VIEWS.forEach(v => { $("#v-" + v).hidden = v !== view; });
  $$(".side-nav a").forEach(a => { if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  closeSide();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
const openSide = () => { $("#side").classList.add("open"); $("#scrim").hidden = false; };
const closeSide = () => { $("#side").classList.remove("open"); $("#scrim").hidden = true; };
$("#side-open").addEventListener("click", openSide);
$("#side-close").addEventListener("click", closeSide);
$("#scrim").addEventListener("click", closeSide);

/* ================= render ================= */
function renderAll() { renderBadges(); renderToday(); renderAgenda(); renderPregrind(); renderHands(); renderPlantao(); renderLeaks(); renderTags(); }

function counts() {
  return {
    rever: S.hands.filter(h => h.status !== "revisada").length,
    plantao: S.hands.filter(h => h.plantao && !h.plantao_answer).length,
    pregrind: S.pregrind.filter(p => !p.done).length
  };
}
function renderBadges() {
  const c = counts();
  [["#b-maos", c.rever], ["#b-plantao", c.plantao], ["#b-pregrind", c.pregrind]].forEach(([sel, n]) => {
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
    <a class="kpi gold" href="#maos"><b>${c.rever}</b><span>Mãos para rever</span></a>
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

/* ---- mãos ---- */
const F = { q: "", status: "rever", tag: "", site: "", leak: "" };
function handCard(h) {
  const imgs = imagesOf(h.id), first = imgs[0], url = first && S.urls.get(first.path);
  return `<button type="button" class="hand" data-hand="${h.id}">
    <div class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<span class="noimg">${h.hero_cards ? "" : "?"}</span>`}${imgs.length > 1 ? `<span class="n">${imgs.length} prints</span>` : ""}</div>
    <div class="body">
      <div class="top">${h.hero_cards ? `<span class="cards">${esc(h.hero_cards)}</span>` : ""}${h.position ? `<span class="pos">${esc(h.position)}</span>` : ""}${h.stack_bb ? `<span class="pos">${esc(h.stack_bb)}bb</span>` : ""}
        ${h.plantao ? `<span class="st pl">plantão</span>` : ""}<span class="st ${h.status === "revisada" ? "revisada" : "rever"}">${h.status === "revisada" ? "revisada" : "rever"}</span></div>
      ${h.tournament || h.site ? `<div class="tour">${esc([h.site, h.tournament].filter(Boolean).join(" · "))}${h.played_on ? " · " + shortDate(h.played_on) : ""}</div>` : ""}
      ${h.question ? `<div class="q">${esc(h.question)}</div>` : ""}
      ${h.plantao_answer && view === "plantao" ? `<div class="ans">↳ ${esc(h.plantao_answer)}</div>` : ""}
      ${h.tags?.length ? `<div class="tags">${h.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    </div></button>`;
}
function renderHands() {
  const tagSel = $("#f-tag"), leakSel = $("#f-leak");
  tagSel.innerHTML = `<option value="">Todos os spots</option>` + S.tags.map(t => `<option ${F.tag === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  leakSel.innerHTML = `<option value="">Qualquer leak</option>` + S.leaks.map(l => `<option value="${l.id}" ${F.leak === l.id ? "selected" : ""}>${esc(l.title)}</option>`).join("");
  const words = F.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.hands.filter(h => {
    if (F.status === "rever" && h.status === "revisada") return false;
    if (F.status === "revisada" && h.status !== "revisada") return false;
    if (F.tag && !h.tags?.includes(F.tag)) return false;
    if (F.site && h.site !== F.site) return false;
    if (F.leak && h.leak_id !== F.leak) return false;
    if (words.length) {
      const hay = [h.tournament, h.situation, h.question, h.conclusion, h.hero_cards, h.board, h.site, h.position, ...(h.tags || [])].join(" ").toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });
  $("#hand-grid").innerHTML = list.length ? list.map(handCard).join("")
    : `<p class="empty" style="grid-column:1/-1">${S.hands.length ? "Nenhuma mão com esses filtros." : "Nenhuma mão ainda. Cole um print aqui ou clique em “+ Nova mão”."}</p>`;
}
$("#f-q").addEventListener("input", e => { F.q = e.target.value; renderHands(); });
$("#f-tag").addEventListener("change", e => { F.tag = e.target.value; renderHands(); });
$("#f-site").addEventListener("change", e => { F.site = e.target.value; renderHands(); });
$("#f-leak").addEventListener("change", e => { F.leak = e.target.value; renderHands(); });
$("#f-status").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  F.status = b.dataset.s; $$("#f-status button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderHands();
});

/* ---- plantão ---- */
function renderPlantao() {
  const open = S.hands.filter(h => h.plantao && !h.plantao_answer);
  const done = S.hands.filter(h => h.plantao && h.plantao_answer).slice(0, 30);
  $("#pl-count").textContent = open.length ? `(${open.length})` : "";
  $("#pl-open").innerHTML = open.length ? open.map(handCard).join("") : `<p class="empty" style="grid-column:1/-1">Nada pendente. Marque “Levar pro plantão” numa mão ou crie uma dúvida sem mão.</p>`;
  $("#pl-done").innerHTML = done.length ? done.map(handCard).join("") : `<p class="empty" style="grid-column:1/-1">As respostas do coach vão aparecer aqui.</p>`;
}

/* ---- leaks ---- */
function renderLeaks() {
  $("#leak-list").innerHTML = S.leaks.length ? S.leaks.map(l => {
    const n = S.hands.filter(h => h.leak_id === l.id).length;
    return `<li class="${l.status === "corrigido" ? "fixed" : ""}" data-leak="${l.id}">
      <input type="checkbox" ${l.status === "corrigido" ? "checked" : ""} title="Marcar como corrigido" aria-label="Corrigido" style="width:18px;height:18px;accent-color:var(--accent)">
      <div style="min-width:0"><div class="t">${esc(l.title)}</div>${l.description ? `<div class="d">${esc(l.description)}</div>` : ""}</div>
      <button class="cnt" type="button" data-leak-hands>${n} ${n === 1 ? "mão" : "mãos"}</button>
      <button class="x" type="button" data-del-leak aria-label="Excluir">×</button></li>`;
  }).join("") : `<li style="display:block;border:0"><p class="empty">Nenhum leak anotado.</p></li>`;
}

/* ---- ajustes ---- */
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

/* ================= delete confirm ================= */
function armDelete(btn, label, onConfirm) {
  btn.removeAttribute("data-armed"); btn.textContent = label;
  btn.onclick = () => {
    if (btn.hasAttribute("data-armed")) { onConfirm(); return; }
    btn.setAttribute("data-armed", ""); btn.textContent = "Confirmar exclusão";
  };
}
$$("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

/* ================= hand editor ================= */
const H = { hand: null, pending: [], removed: [] }; // pending: [{blob, url}]
const dlgHand = $("#dlg-hand");

function openHand(id, files = [], opts = {}) {
  const h = id ? S.hands.find(x => x.id === id) : null;
  H.hand = h; H.pending = []; H.removed = [];
  aiSeq++; clearTimeout(aiTimer);
  $("#h-head").textContent = h ? "Mão" : (opts.doubt ? "Nova dúvida" : "Nova mão");
  $("#h-date").value = h?.played_on || today();
  $("#h-site").value = h?.site || "";
  $("#h-tour").value = h?.tournament || "";
  $("#h-cards").value = h?.hero_cards || "";
  $("#h-pos").value = h?.position || "";
  $("#h-stack").value = h?.stack_bb ?? "";
  $("#h-board").value = h?.board || "";
  $("#h-sit").value = h?.situation || "";
  $("#h-question").value = h?.question || "";
  $("#h-conclusion").value = h?.conclusion || "";
  $("#h-status").value = h?.status === "revisada" ? "revisada" : "rever";
  $("#h-leak").innerHTML = `<option value="">Nenhum</option>` + S.leaks.map(l => `<option value="${l.id}">${esc(l.title)}</option>`).join("");
  $("#h-leak").value = h?.leak_id || "";
  $("#h-plantao").checked = h ? !!h.plantao : !!opts.doubt;
  $("#h-pans").value = h?.plantao_answer || "";
  $("#h-pans-wrap").hidden = !$("#h-plantao").checked;
  const sel = new Set(h?.tags || []);
  $("#h-tags").innerHTML = S.tags.length
    ? S.tags.map(t => `<button type="button" aria-pressed="${sel.has(t.name)}">${esc(t.name)}</button>`).join("")
    : `<span class="muted" style="font-size:.85rem">Nenhum spot cadastrado. Adicione em Ajustes.</span>`;
  $$("#f-hand .ai-filled").forEach(el => el.classList.remove("ai-filled"));
  $("#h-del").hidden = !h;
  if (h) armDelete($("#h-del"), "Excluir", deleteHand);
  aiMsg(aiOff ? "Leitura automática desativada (falta a chave da IA na Vercel)." : "Ao colar um print, a IA preenche os campos sozinha.", aiOff ? "warn" : "");
  renderGallery();
  if (!dlgHand.open) dlgHand.showModal();
  if (files.length) addFiles(files);
  else setTimeout(() => (h ? null : (opts.doubt ? $("#h-question") : $("#h-cards")))?.focus(), 50);
}

/* imagens: converte para JPEG (menor, mais rápido para enviar e para a IA ler) */
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
  for (const f of imgs) { const blob = await compress(f); H.pending.push({ blob, url: URL.createObjectURL(blob) }); }
  renderGallery();
  scheduleAI();
}
function renderGallery() {
  const saved = H.hand ? imagesOf(H.hand.id).filter(i => !H.removed.includes(i.id)) : [];
  $("#h-gallery").innerHTML =
    saved.map(i => `<div class="gimg"><img src="${esc(S.urls.get(i.path) || "")}" alt="Print" data-zoom><button type="button" class="rm" data-rm-saved="${i.id}" aria-label="Remover">✕</button></div>`).join("") +
    H.pending.map((p, n) => `<div class="gimg"><img src="${p.url}" alt="Print novo" data-zoom><span class="new">novo</span><button type="button" class="rm" data-rm-pending="${n}" aria-label="Remover">✕</button></div>`).join("");
  $("#h-ai-run").hidden = !(saved.length || H.pending.length);
}

/* ================= leitura com IA ================= */
let aiTimer, aiOff = false, aiSeq = 0;
function aiMsg(text, cls = "") { const el = $("#h-ai-msg"); el.textContent = text; $("#h-ai").className = "ai-bar " + cls; }
function scheduleAI() { if (aiOff) return; clearTimeout(aiTimer); aiTimer = setTimeout(() => runAI(false), 800); }
async function runAI(manual) {
  const seq = ++aiSeq;
  const saved = H.hand ? imagesOf(H.hand.id).filter(i => !H.removed.includes(i.id)) : [];
  if (!saved.length && !H.pending.length) { if (manual) aiMsg("Adicione um print primeiro."); return; }
  aiMsg("Lendo o print com IA…", "busy"); $("#h-ai-run").disabled = true;
  try {
    const blobs = [];
    for (const i of saved) {
      const u = S.urls.get(i.path);
      if (u) { try { blobs.push(await compress(await (await fetch(u)).blob(), 1600, 0.85)); } catch { } }
    }
    for (const p of H.pending) blobs.push(await compress(p.blob, 1600, 0.85));
    const images = await Promise.all(blobs.slice(0, 6).map(toBase64));
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify({ images, tags: S.tags.map(t => t.name), sites: SITES, positions: POSITIONS, heroNicks: HERO_NICKS })
    });
    const j = await r.json().catch(() => ({}));
    if (seq !== aiSeq || !dlgHand.open) return;
    if (r.status === 503 && j.error === "missing_key") { aiOff = true; aiMsg("Leitura automática desativada (falta a chave da IA na Vercel).", "warn"); return; }
    if (r.status === 404) { aiMsg("A função de IA ainda não está publicada.", "warn"); return; }
    if (!r.ok) throw new Error(j.detail || j.error || "HTTP " + r.status);
    applyAI(j);
  } catch (e) {
    if (seq === aiSeq) aiMsg("Não deu para ler o print: " + (e.message || e), "warn");
  } finally {
    if (seq === aiSeq) $("#h-ai-run").disabled = false;
  }
}
function applyAI(a) {
  let n = 0;
  const put = (sel, val) => {
    const el = $(sel);
    if (val === null || val === undefined || String(val).trim() === "" || el.value.trim()) return;
    el.value = String(val); el.classList.add("ai-filled"); n++;
  };
  if (a.site && SITES.includes(a.site)) put("#h-site", a.site);
  put("#h-tour", a.tournament);
  put("#h-cards", [a.hero_combo, a.hero_exact].filter(Boolean).join(" · "));
  if (a.position && POSITIONS.includes(a.position)) put("#h-pos", a.position);
  if (typeof a.stack_bb === "number") put("#h-stack", Math.round(a.stack_bb * 10) / 10);
  put("#h-board", a.board);
  put("#h-sit", a.situation);
  put("#h-question", a.question_suggestion);
  const want = new Set(Array.isArray(a.tags) ? a.tags : []);
  $$("#h-tags button").forEach(b => {
    if (want.has(b.textContent) && b.getAttribute("aria-pressed") !== "true") { b.setAttribute("aria-pressed", "true"); b.classList.add("ai-filled"); n++; }
  });
  aiMsg(n ? "Preenchido pela IA. Confira os campos destacados antes de salvar." : "A IA não encontrou nada novo para preencher.", "ok");
}
$("#h-ai-run").addEventListener("click", () => { aiOff = false; runAI(true); });
$("#f-hand").addEventListener("input", e => e.target.classList.remove("ai-filled"));
$("#f-hand").addEventListener("change", e => e.target.classList.remove("ai-filled"));

$("#h-gallery").addEventListener("click", e => {
  const rs = e.target.closest("[data-rm-saved]"), rp = e.target.closest("[data-rm-pending]"), z = e.target.closest("[data-zoom]");
  if (rs) { H.removed.push(rs.dataset.rmSaved); renderGallery(); }
  else if (rp) { const [p] = H.pending.splice(+rp.dataset.rmPending, 1); URL.revokeObjectURL(p.url); renderGallery(); }
  else if (z) { $("#viewer-img").src = z.src; $("#dlg-view").showModal(); }
});
$("#h-tags").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); b.classList.remove("ai-filled");
});
$("#h-plantao").addEventListener("change", e => { $("#h-pans-wrap").hidden = !e.target.checked; });
$("#h-file").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; addFiles(f); });
const drop = $("#h-drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
dlgHand.addEventListener("close", () => { aiSeq++; clearTimeout(aiTimer); H.pending.forEach(p => URL.revokeObjectURL(p.url)); H.pending = []; });

$("#f-hand").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#h-save"); btn.disabled = true; btn.textContent = "Salvando…";
  const stack = $("#h-stack").value;
  const plantao = $("#h-plantao").checked;
  const row = {
    played_on: $("#h-date").value || null, site: $("#h-site").value || null, tournament: $("#h-tour").value.trim() || null,
    hero_cards: $("#h-cards").value.trim() || null, position: $("#h-pos").value || null, stack_bb: stack === "" ? null : +stack,
    board: $("#h-board").value.trim() || null, situation: $("#h-sit").value.trim() || null,
    tags: $$("#h-tags button[aria-pressed=true]").map(b => b.textContent),
    question: $("#h-question").value.trim() || null, conclusion: $("#h-conclusion").value.trim() || null,
    status: $("#h-status").value, leak_id: $("#h-leak").value || null,
    plantao, plantao_answer: plantao ? ($("#h-pans").value.trim() || null) : null
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
    // remover prints apagados
    if (H.removed.length) {
      const gone = S.images.filter(i => H.removed.includes(i.id));
      await q(sb.from("hand_images").delete().in("id", H.removed), "remover prints");
      await sb.storage.from("hands").remove(gone.map(i => i.path));
      S.images = S.images.filter(i => !H.removed.includes(i.id));
    }
    // enviar prints novos
    let sort = imagesOf(hand.id).reduce((m, i) => Math.max(m, i.sort), -1) + 1;
    for (const p of H.pending) {
      const type = p.blob.type || "image/jpeg";
      const ext = (type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const path = `${S.user.id}/${hand.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const { error } = await sb.storage.from("hands").upload(path, p.blob, { contentType: type, upsert: false });
      if (error) { fail(error, "enviar um print"); continue; }
      const img = await q(sb.from("hand_images").insert({ hand_id: hand.id, path, sort: sort++ }).select().single(), "registrar o print");
      S.images.push(img);
      S.urls.set(path, p.url); // usa a prévia local até recarregar
    }
    H.pending = []; // não revogar as URLs usadas como prévia
    dlgHand.close();
    toast("Mão salva");
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
    dlgHand.close(); toast("Mão excluída"); renderAll();
  } catch { /* já avisado */ }
}

/* ================= paste & drag anywhere ================= */
document.addEventListener("paste", e => {
  if ($("#app").hidden) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  if (dlgHand.open) { addFiles(files); toast("Print adicionado"); }
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
  if (dlgHand.open) addFiles(files); else openHand(null, files);
});

/* ================= events (agenda) ================= */
let editEv = null;
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

/* ================= clicks ================= */
document.addEventListener("click", async e => {
  const t = e.target;
  const ne = t.closest("[data-new-event]"); if (ne) { openEvent(null, ne.dataset.newEvent === "today" ? today() : ne.dataset.newEvent); return; }
  const ev = t.closest("[data-ev]"); if (ev) { openEvent(ev.dataset.ev); return; }
  const hd = t.closest("[data-hand]"); if (hd) { openHand(hd.dataset.hand); return; }

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
      location.hash = "maos"; renderHands(); return;
    }
    try {
      if (t.closest("[data-del-leak]")) { await q(sb.from("leaks").delete().eq("id", l.id), "excluir o leak"); S.leaks = S.leaks.filter(x => x.id !== l.id); S.hands.forEach(h => { if (h.leak_id === l.id) h.leak_id = null; }); }
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

/* ================= forms ================= */
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

boot();
