// Leituras sob demanda para o HRC. Só roda quando você clica no botão do site.
//  mode "payouts": lê o print do lobby e devolve as faixas de premiação (modelo barato, é só ler uma tabela).
//  mode "table":   lê o print da mesa (+ lobby) e devolve jogadores, stacks, bounties, blinds e ante.
// O site monta o .json e o histórico no formato PokerStars a partir disso, sem gastar IA de novo.

const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";
const MODEL_PAYOUTS = process.env.HRC_PAYOUTS_MODEL || "claude-haiku-5-5";
const MODEL_TABLE = process.env.HRC_TABLE_MODEL || "claude-sonnet-5-5";
const num = { type: ["number", "null"] };
const str = { type: ["string", "null"] };

const PAYOUTS_TOOL = {
  name: "registrar_premiacao",
  description: "Registra a premiação e os dados do torneio lidos no print do lobby.",
  input_schema: {
    type: "object",
    properties: {
      tournament: { ...str, description: "Nome do torneio como aparece no lobby." },
      site: { ...str, description: "Sala (PokerStars, GGPoker, CoinPoker, PartyPoker, iPoker, Bodog, YaPoker)." },
      currency: { ...str, description: "Moeda, ex.: USD." },
      buyin_total: { ...num, description: "Buy-in total em dinheiro (ex.: 54)." },
      bounty_type: { type: ["string", "null"], enum: ["pko", "ko", "mystery", "none", null], description: "pko se for bounty progressivo (ex.: Bounty Hunters, Progressive KO), ko se bounty fixo, mystery, ou none." },
      prize_pool: { ...num, description: "Prize pool total mostrado." },
      entrants: { ...num, description: "Total de inscritos (ex.: de \"3,063 / 19,928\" é 19928)." },
      players_left: { ...num, description: "Jogadores restantes (ex.: de \"3,063 / 19,928\" é 3063)." },
      places_paid: { ...num, description: "Número de posições pagas." },
      small_blind: { ...num, description: "Small blind do nível atual em fichas." },
      big_blind: { ...num, description: "Big blind do nível atual em fichas." },
      ante: { ...num, description: "Ante POR JOGADOR do nível atual em fichas, se aparecer (ex.: \"2,000 / 4,000 (600)\" → 600)." },
      payouts: {
        type: "array",
        description: "TODAS as linhas da tabela de premiação visíveis, de cima para baixo. Uma faixa \"11 ~ 12\" vira from 11, to 12. Linha única \"5\" vira from 5, to 5. Valor SEM o bounty (ignore \"+ Bounty\").",
        items: {
          type: "object",
          properties: { from: { type: "integer" }, to: { type: "integer" }, amount: { type: "number" } },
          required: ["from", "to", "amount"]
        }
      }
    },
    required: ["tournament", "site", "currency", "buyin_total", "bounty_type", "prize_pool", "entrants", "players_left", "places_paid", "small_blind", "big_blind", "ante", "payouts"]
  }
};

const TABLE_TOOL = {
  name: "registrar_mesa",
  description: "Registra a mesa no início da mão para montar um histórico de mão.",
  input_schema: {
    type: "object",
    properties: {
      small_blind: { ...num, description: "Small blind em fichas (do lobby ou da mesa)." },
      big_blind: { ...num, description: "Big blind em fichas (do lobby ou da mesa)." },
      ante_per_player: { ...num, description: "Ante por jogador em fichas, se aparecer no lobby/nível (ex.: (600))." },
      ante_total_bb: { ...num, description: "Total de antes no centro da mesa em BB, se aparecer separado das apostas (ex.: pilha de 0,9 BB no meio no pré-flop)." },
      buyin_total: { ...num, description: "Buy-in total em dinheiro, se aparecer." },
      bounty_type: { type: ["string", "null"], enum: ["pko", "ko", "mystery", "none", null] },
      hero_cards: { ...str, description: "Cartas do hero no formato do PokerStars: valor (2-9, T, J, Q, K, A) + naipe minúsculo (c, d, h, s), separadas por espaço. Ex.: \"Ac Jd\". Naipe pela cor em baralho de 4 cores: verde c, azul d, vermelho h, preto s." },
      players: {
        type: "array",
        description: "Jogadores SENTADOS na mesa, em sentido horário COMEÇANDO PELO BOTÃO (BTN, depois SB, BB, ...). Inclua quem já foldou também, pois todos estavam na mão no início.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nick exatamente como aparece (pode estar cortado)." },
            position: { type: ["string", "null"], description: "BTN, SB, BB, UTG, UTG+1, UTG+2, LJ, HJ, CO." },
            stack_bb: { type: "number", description: "Stack mostrado embaixo do nick, em BB." },
            front_bb: { type: "number", description: "Fichas que o jogador tem apostadas na frente dele nesta street (blind, aposta), em BB. 0 se nada." },
            bounty: { type: ["number", "null"], description: "Bounty do jogador em dinheiro, se aparecer (ex.: etiqueta $5,00 → 5)." },
            hero: { type: "boolean" }
          },
          required: ["name", "position", "stack_bb", "front_bb", "bounty", "hero"]
        }
      }
    },
    required: ["small_blind", "big_blind", "ante_per_player", "ante_total_bb", "buyin_total", "bounty_type", "hero_cards", "players"]
  }
};

const PROMPT_PAYOUTS = `Este é um print do lobby de um torneio de poker online. Leia a tabela de premiação (Prize Pool / Payouts) e os dados do torneio e registre com a ferramenta registrar_premiacao. Responda SOMENTE chamando a ferramenta.
- Copie TODAS as linhas da premiação que estiverem visíveis, na ordem, sem pular nenhuma, com os valores exatos.
- Números usam vírgula como separador de milhar em inglês (39,402.68 = 39402.68).
- Se uma informação não estiver visível, use null. Nunca invente.`;

const PROMPT_TABLE = `Você recebe o print da mesa no começo da mão e, às vezes, um print do lobby do torneio. Registre a mesa com a ferramenta registrar_mesa para montar um histórico de mão. Responda SOMENTE chamando a ferramenta.
- O hero é o jogador embaixo, com as cartas viradas para cima.
- Liste TODOS os jogadores sentados, em sentido horário a partir do botão do dealer (disco "D"). O primeiro da lista é o BTN, o segundo o SB, o terceiro o BB.
- stack_bb é o número embaixo do nick. front_bb são as fichas paradas na frente do jogador (blinds/apostas). A pilha no centro da mesa no pré-flop são os antes (ante_total_bb), não pertencem a ninguém.
- Blinds e ante em fichas: use o nível do lobby (ex.: "2,000 / 4,000 (600)" → SB 2000, BB 4000, ante 600 por jogador). Se não houver lobby, use null.
- Bounty: etiqueta em dinheiro perto do avatar (ex.: $5,00 → 5). Vírgula pode ser decimal (5,00 = 5).
- Nunca invente: o que não estiver visível vai como null.`;

async function authOk(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    return u.ok;
  } catch { return false; }
}

function readTool(j) {
  let out = (j.content || []).find(c => c.type === "tool_use")?.input;
  if (!out) {
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
  }
  for (const k of ["payouts", "players"]) if (out && typeof out[k] === "string") { try { out[k] = JSON.parse(out[k]); } catch { out[k] = []; } }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "missing_key" });
  if (!(await authOk(req))) return res.status(401).json({ error: "unauthorized" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const mode = body.mode === "table" ? "table" : "payouts";
  const images = (Array.isArray(body.images) ? body.images : []).filter(x => typeof x === "string").slice(0, 3);
  if (!images.length) return res.status(400).json({ error: "no_images" });

  const labels = Array.isArray(body.labels) ? body.labels : [];
  const content = [];
  images.forEach((data, i) => {
    if (labels[i]) content.push({ type: "text", text: labels[i] });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  });
  content.push({ type: "text", text: mode === "table" ? PROMPT_TABLE : PROMPT_PAYOUTS });
  const tool = mode === "table" ? TABLE_TOOL : PAYOUTS_TOOL;
  const model = mode === "table" ? MODEL_TABLE : MODEL_PAYOUTS;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 12000, tools: [tool], tool_choice: { type: "auto" }, messages: [{ role: "user", content }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "ai_error", detail: j?.error?.message || `HTTP ${r.status}` });
    const out = readTool(j);
    if (!out) return res.status(502).json({ error: "ai_error", detail: "a IA respondeu sem os dados; tente de novo" });
    out.model = model;
    out.stop_reason = j.stop_reason;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "ai_unreachable", detail: String(e?.message || e) });
  }
};
