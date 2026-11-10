// Lê prints de mesa de poker com a IA da Anthropic e devolve os campos da mão.
// Precisa da variável de ambiente ANTHROPIC_API_KEY na Vercel (Settings → Environment Variables).
// Só responde a quem está logado no site (confere o token no Supabase).

const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

const TOOL = {
  name: "registrar_mao",
  description: "Registra os dados da mão de poker lidos nos prints.",
  input_schema: {
    type: "object",
    properties: {
      site: { type: ["string", "null"], description: "Sala, exatamente um dos nomes da lista de salas, ou null se não der para saber." },
      tournament: { type: ["string", "null"], description: "Nome curto do torneio: buy-in + nome principal + formato. Tire números de episódio, garantido, nível de blinds, número da mesa e textos entre colchetes que não sejam o nome. Ex.: título \"Episode 12: $55 NLHE [Bounty, Big Game] $200K Gtd - Table 31\" vira \"$55 Big Game Bounty\"." },
      hero_combo: { type: ["string", "null"], description: "Mão do hero em notação de combo: AQo, KTs, 99." },
      hero_exact: { type: ["string", "null"], description: "Cartas exatas com naipe, se visíveis, seguindo a regra de cores do baralho. Ex.: \"K♥J♠\"." },
      position: { type: ["string", "null"], description: "Posição do hero, exatamente um dos nomes da lista de posições, ou null." },
      stack_bb: { type: ["number", "null"], description: "Stack do hero em big blinds no momento da decisão (o maior street mostrado)." },
      players: { type: ["integer", "null"], description: "Número de jogadores sentados na mesa." },
      board: { type: ["string", "null"], description: "Board completo visível no último print, com naipes, separado por espaços, seguindo a regra de cores do baralho. Formato: \"K♠ 7♦ 2♣ Q♥\". Use T para dez." },
      street: { type: ["string", "null"], enum: ["preflop", "flop", "turn", "river", null] },
      situation: { type: ["string", "null"], description: "Resumo objetivo em português, no máximo 2 frases curtas, só com fatos visíveis: tipo de pote (SRP, 3bet pot, multiway), posições, stacks, street, pote em BB e a ação que o hero enfrenta (ex.: vilão apostou 6.5bb, ou hero é o primeiro a agir). Sem especulação sobre ranges e sem pontos de interrogação. Ex.: \"SRP multiway, hero CO 38.6bb. River, pote 22.1bb, hero é o primeiro a agir.\"" },
      question_suggestion: { type: ["string", "null"], description: "Pergunta curta em português sobre a decisão do hero, no estilo \"Call vs bet de 6.5bb no turn?\" ou \"Lead no river?\"." },
      tags: { type: "array", items: { type: "string" }, description: "De 0 a 2 spots da lista que descrevem a decisão do hero. Use somente nomes exatos da lista. Na dúvida, não marque nenhum." }
    },
    required: ["site", "tournament", "hero_combo", "hero_exact", "position", "stack_bb", "players", "board", "street", "situation", "question_suggestion", "tags"]
  }
};

function prompt({ sites, positions, tags, heroNicks, count }) {
  return `Você recebe ${count} print(s) de uma mesa de poker online, na ordem em que a mão aconteceu (normalmente um print por street).
Leia com atenção e registre a mão usando a ferramenta registrar_mao.

Regras:
- O hero é o jogador sentado embaixo, com as cartas viradas para cima${heroNicks?.length ? ` (nick: ${heroNicks.join(", ")})` : ""}.
- NAIPES: as salas costumam usar baralho de 4 cores. Decida o naipe pela COR do fundo ou do símbolo da carta: verde = ♣ paus, azul = ♦ ouros, vermelho = ♥ copas, preto/cinza escuro = ♠ espadas. Só use outra regra se o baralho for claramente de 2 cores (aí olhe o símbolo).
- Salas possíveis: ${sites.join(", ")}. Identifique pelo visual da mesa, logo ou título da janela.
- O nome do torneio costuma estar no título da janela. Encurte como explicado no campo tournament.
- Posições possíveis: ${positions.join(", ")}. Ache o botão do dealer (disco com "D" perto de um jogador). Esse jogador é o BTN. Seguindo no sentido horário a partir dele: SB, BB, e depois as demais posições até voltar ao BTN. Numa mesa de 9: BTN, SB, BB, UTG, UTG+1, UTG+2, LJ, HJ, CO. Com menos jogadores, somem as primeiras depois do BB (mesa de 6: BTN, SB, BB, LJ, HJ, CO). Conte só os assentos ocupados. Se não enxergar o botão, use null.
- Stacks e potes geralmente aparecem em BB. Se aparecerem em fichas, converta usando o big blind do título, se houver.
- Com vários prints, use os anteriores para entender a ação (quem apostou, quem deu call) e o último para board, pote e stacks.
- Spots possíveis: ${tags.join(" | ")}. Escolha só os que realmente descrevem a decisão. Exemplos: "lead" = hero fora de posição apostando primeiro após ter dado call na street anterior; "bluff catch" = hero decidindo se paga uma aposta grande com mão marginal; "call vs barril turn/river" = hero enfrentando aposta no turn ou river depois de ter pagado antes.
- Nunca invente: se algo não estiver visível, use null.`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "missing_key" });

  // só o dono logado pode usar
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return res.status(401).json({ error: "unauthorized" });
  } catch {
    return res.status(502).json({ error: "auth_unreachable" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const images = Array.isArray(body.images) ? body.images.filter(x => typeof x === "string").slice(0, 6) : [];
  if (!images.length) return res.status(400).json({ error: "no_images" });
  const ctx = {
    sites: Array.isArray(body.sites) ? body.sites.slice(0, 30) : [],
    positions: Array.isArray(body.positions) ? body.positions.slice(0, 12) : [],
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 80) : [],
    heroNicks: Array.isArray(body.heroNicks) ? body.heroNicks.slice(0, 10) : [],
    count: images.length
  };

  const content = [
    ...images.map(data => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
    { type: "text", text: prompt(ctx) }
  ];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "registrar_mao" },
        messages: [{ role: "user", content }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "ai_error", detail: j?.error?.message || `HTTP ${r.status}` });
    const out = (j.content || []).find(c => c.type === "tool_use")?.input || {};
    // garante que spots, salas e posições venham só das listas
    if (Array.isArray(out.tags)) out.tags = out.tags.filter(t => ctx.tags.includes(t)).slice(0, 3);
    if (out.site && !ctx.sites.includes(out.site)) out.site = null;
    if (out.position && !ctx.positions.includes(out.position)) out.position = null;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "ai_unreachable", detail: String(e?.message || e) });
  }
};
