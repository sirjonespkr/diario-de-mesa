// Monta os arquivos do HRC a partir do que a IA leu nos prints. Tudo aqui é código puro: não gasta IA.

const r2 = n => Math.round(n * 100) / 100;
const money = n => (Math.round(n * 100) / 100).toFixed(2);

// número estável a partir de um texto (para o nº do torneio/mão não mudar a cada clique)
function stableDigits(text, len) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let out = "";
  while (out.length < len) { h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; out += String(h); }
  return (String((h % 9) + 1) + out).slice(0, len);
}

/* ---------- premiação → .json (formato SharkScope, que o HRC importa) ---------- */
export function checkPayouts(p) {
  const rows = (p?.payouts || []).filter(x => Number.isFinite(x.from) && Number.isFinite(x.to) && Number.isFinite(x.amount) && x.to >= x.from)
    .sort((a, b) => a.from - b.from);
  const problems = [];
  let expect = 1;
  for (const x of rows) {
    if (x.from > expect) problems.push(`faltam as posições ${expect}${x.from - 1 > expect ? "–" + (x.from - 1) : ""}`);
    if (x.from < expect) problems.push(`posições repetidas perto de ${x.from}`);
    expect = Math.max(expect, x.to + 1);
  }
  const lastPaid = expect - 1;
  if (p?.places_paid && lastPaid !== p.places_paid) problems.push(`a tabela vai até ${lastPaid}, mas o lobby diz ${p.places_paid} pagos`);
  for (let i = 1; i < rows.length; i++) if (rows[i].amount > rows[i - 1].amount + 0.001) problems.push(`o prêmio da posição ${rows[i].from} é maior que o da anterior`);
  return { rows, lastPaid, problems };
}

export function buildPayoutsJson(p, { handKey = "", site } = {}) {
  const { rows, lastPaid } = checkPayouts(p);
  const entries = [];
  for (const x of rows) for (let pos = x.from; pos <= x.to; pos++) entries.push({ pos, amount: x.amount });
  const prizePool = r2(entries.reduce((a, e) => a + e.amount, 0));
  const network = p.site || site || "PokerStars";
  const id = stableDigits("t" + handKey + (p.tournament || ""), 9);
  const total = Math.max(p.entrants || 0, lastPaid);
  const buyin = p.buyin_total || 0;
  const rake = r2(buyin - buyin / 1.08);
  return {
    CompletedTournament: {
      "@id": id,
      "@name": p.tournament || "Torneio",
      "@network": network,
      "@currency": p.currency || "USD",
      "@prizePool": money(prizePool),
      "@stake": money(buyin - rake),
      "@rake": money(rake),
      "@totalEntrants": String(total),
      "@game": "H",
      "@structure": "NL",
      "@state": "Completed",
      "@gameClass": "scheduled",
      "@flags": p.bounty_type && p.bounty_type !== "none" ? "B" : "",
      TournamentEntry: entries.map(e => ({
        "@playerName": `Player ${e.pos}`,
        "@position": String(e.pos),
        "@prize": money(e.amount),
        Player: { "@name": `Player ${e.pos}`, "@network": network }
      }))
    }
  };
}

/* ---------- mesa → histórico de mão no formato PokerStars (o HRC lê colando) ---------- */
const clean = s => String(s || "Jogador").replace(/[:()\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim() || "Jogador";

export function buildPokerStarsHH(t, { handKey = "", date = new Date(), tournament = "", buyinOverride, site = "", fullBountySites = [] } = {}) {
  const warnings = [];
  const players = (t?.players || []).filter(p => p && Number.isFinite(+p.stack_bb));
  if (players.length < 2) throw new Error("a IA não encontrou os jogadores da mesa");
  const n = players.length;

  let bb = +t.big_blind || 0, sb = +t.small_blind || 0;
  if (!bb) { bb = 100; warnings.push("big blind não apareceu no print: usei 100 fichas (tudo fica proporcional em BB)"); }
  if (!sb) sb = bb / 2;
  let ante = +t.ante_per_player || 0;
  if (!ante && +t.ante_total_bb) ante = Math.round((+t.ante_total_bb * bb) / n);
  if (!ante) warnings.push("ante não apareceu: ficou 0");

  // nomes únicos
  const seen = {};
  players.forEach(p => { let nm = clean(p.name); if (seen[nm]) nm += " " + (++seen[nm]); else seen[nm] = 1; p._name = nm; });

  // stack do começo da mão = stack mostrado + fichas na frente + ante já colocado no pote
  const chips = players.map(p => Math.max(1, Math.round((+p.stack_bb + (+p.front_bb || 0)) * bb + ante)));

  const heroIdx = players.findIndex(p => p.hero);
  if (heroIdx < 0) warnings.push("não identifiquei o hero na lista");
  const cards = String(t.hero_cards || "").trim();
  if (!/^[2-9TJQKA][cdhs] [2-9TJQKA][cdhs]$/.test(cards)) warnings.push("cartas do hero não foram lidas no formato certo");

  // buy-in no cabeçalho (bounty progressivo: metade vai para o bounty)
  const total = +(buyinOverride ?? t.buyin_total) || 0;
  const isBounty = t.bounty_type && t.bounty_type !== "none";
  let buyinStr;
  if (!total) buyinStr = isBounty ? "$5+$5+$1" : "$10+$1";
  else {
    const net = r2(total / 1.08), rake = r2(total - net);
    buyinStr = isBounty ? `$${money(net / 2)}+$${money(net / 2)}+$${money(rake)}` : `$${money(net)}+$${money(rake)}`;
  }
  if (!total) warnings.push("buy-in não apareceu: usei um valor genérico no cabeçalho");
  if (isBounty && players.some(p => p.bounty == null)) warnings.push("bounty de algum jogador não apareceu no print");
  // PKO: a mesa mostra metade (o que se ganha ao eliminar), exceto nas salas que mostram o total
  const showsFull = fullBountySites.some(x => x.toLowerCase() === String(site || "").toLowerCase());
  const bountyMult = t.bounty_type === "pko" && !showsFull ? 2 : 1;

  const handNo = stableDigits("h" + handKey, 12);
  const tourNo = stableDigits("t" + handKey + tournament, 10);
  const d = date instanceof Date ? date : new Date(date);
  const pad = x => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const maxSeats = n <= 6 ? 6 : n <= 8 ? 8 : 9;

  // assentos: lista começa no botão → assento 1 é o botão
  const btn = 0, sbI = n === 2 ? 0 : 1, bbI = n === 2 ? 1 : 2;
  const L = [];
  L.push(`PokerStars Hand #${handNo}: Tournament #${tourNo}, ${buyinStr} USD Hold'em No Limit - Level I (${sb}/${bb}) - ${stamp} ET`);
  L.push(`Table '${tourNo} 1' ${maxSeats}-max Seat #${btn + 1} is the button`);
  players.forEach((p, i) => {
    const b = isBounty && p.bounty != null ? `, $${money(+p.bounty * bountyMult)} bounty` : "";
    L.push(`Seat ${i + 1}: ${p._name} (${chips[i]} in chips${b})`);
  });
  if (ante) players.forEach(p => L.push(`${p._name}: posts the ante ${ante}`));
  L.push(`${players[sbI]._name}: posts small blind ${sb}`);
  L.push(`${players[bbI]._name}: posts big blind ${bb}`);
  L.push("*** HOLE CARDS ***");
  if (heroIdx >= 0 && cards) L.push(`Dealt to ${players[heroIdx]._name} [${cards}]`);
  // mão "fechada" válida: todos foldam até o BB (o HRC só precisa de stacks, posições, blinds, ante, bounties e cartas)
  for (let k = 1; k < n; k++) { const i = (bbI + k) % n; if (i !== bbI) L.push(`${players[i]._name}: folds`); }
  const uncalled = bb - sb;
  const pot = ante * n + sb * 2;
  if (uncalled > 0) L.push(`Uncalled bet (${uncalled}) returned to ${players[bbI]._name}`);
  L.push(`${players[bbI]._name} collected ${pot} from pot`);
  L.push(`${players[bbI]._name}: doesn't show hand`);
  L.push("*** SUMMARY ***");
  L.push(`Total pot ${pot} | Rake 0`);
  players.forEach((p, i) => {
    if (i === bbI) L.push(`Seat ${i + 1}: ${p._name} (big blind) collected (${pot})`);
    else if (i === sbI) L.push(`Seat ${i + 1}: ${p._name} (small blind) folded before Flop`);
    else L.push(`Seat ${i + 1}: ${p._name}${i === btn ? " (button)" : ""} folded before Flop (didn't bet)`);
  });
  return { text: L.join("\n") + "\n", warnings, summary: { players: n, sb, bb, ante, chips, bountyMult } };
}
