// Lê os prints de uma mão de poker (com as legendas) usando a IA da Anthropic.
// Devolve os dados da mão e uma lista de dúvidas, normalmente uma por print.
// Precisa da variável de ambiente ANTHROPIC_API_KEY na Vercel.
// Só responde a quem está logado no site (confere o token no Supabase).

const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const STREETS = ["preflop", "flop", "turn", "river"];

const TOOL = {
  name: "registrar_mao",
  description: "Registra a mão de poker lida nos prints, com uma lista de dúvidas do hero.",
  input_schema: {
    type: "object",
    properties: {
      site: { type: ["string", "null"], description: "Sala, exatamente um nome da lista de salas, ou null." },
      tournament: { type: ["string", "null"], description: "Nome curto do torneio: buy-in + nome principal + formato. Tire número de episódio, garantido, nível de blinds, número da mesa e textos de evento especial. Ex.: título \"Episode 12: $55 NLHE [Bounty, Season Finale, Big Game], $200K Gtd - 2-Day Event\" vira \"$55 Big Game PKO\"." },
      hero_combo: { type: ["string", "null"], description: "Mão do hero em combo: AQo, KTs, 99." },
      hero_exact: { type: ["string", "null"], description: "Cartas do hero com naipe, pela regra de cores. Ex.: \"K♥J♠\"." },
      position: { type: ["string", "null"], description: "Posição do hero, exatamente um nome da lista de posições, ou null." },
      stack_bb: { type: ["number", "null"], description: "Stack do hero em BB no PRIMEIRO print (início da mão)." },
      board: { type: ["string", "null"], description: "Board final (do último print), com naipes pela regra de cores, separado por espaços, usando T para dez. Formato: \"K♠ 7♦ 2♣ Q♥\"." },
      summary: { type: ["string", "null"], description: "História da mão em português, até 3 frases, só com fatos: contexto do torneio vindo das legendas (ex.: 900 restantes, ITM em 1500), quem abriu e de onde, como o hero entrou, a ação em cada street até a última decisão. Ex.: \"900 restantes (ITM 1500). CO abre 2bb, hero defende no BB. Flop: X/C vs cbet 1/3. Turn: X, vilão aposta 6.5bb.\"" },
      decisions: {
        type: "array",
        description: "Dúvidas do hero, em ordem cronológica. Em regra, uma por print.",
        items: {
          type: "object",
          properties: {
            print: { type: "integer", description: "Número do print (1 = primeiro) que mostra o momento dessa dúvida." },
            street: { type: ["string", "null"], enum: [...STREETS, null], description: "Street em que a dúvida acontece." },
            situation: { type: ["string", "null"], description: "Momento da decisão em 1 frase curta, só fatos: street, pote em BB, stacks se relevantes e o que o hero enfrenta. Ex.: \"Turn, pote 15.6bb, vilão aposta 6.5bb.\"" },
            question: { type: ["string", "null"], description: "A dúvida em português, curta. Se a legenda tiver uma pergunta, reescreva-a de forma clara mantendo o sentido (\"lead??\" vira \"Lead no river depois de X/C no flop e no turn?\"). Se não houver legenda, deduza a decisão mostrada." },
            tags: { type: "array", items: { type: "string" }, description: "De 0 a 2 spots da lista que descrevem ESTA dúvida. Só nomes exatos da lista." }
          },
          required: ["print", "street", "situation", "question", "tags"]
        }
      }
    },
    required: ["site", "tournament", "hero_combo", "hero_exact", "position", "stack_bb", "board", "summary", "decisions"]
  }
};

function prompt({ sites, positions, tags, heroNicks, captions }) {
  const legendas = captions.map((c, i) => `Print ${i + 1}: ${c ? `"${c}"` : "(sem legenda)"}`).join("\n");
  return `Você recebe ${captions.length} print(s) de UMA mão de poker online, em ordem cronológica, cada um com uma legenda opcional escrita pelo hero.
As legendas são anotações rápidas de jogador: contam o que aconteceu entre um print e outro e trazem as dúvidas.
Leia os prints e as legendas juntos, reconstrua a história da mão e registre tudo chamando a ferramenta registrar_mao. Responda SOMENTE chamando a ferramenta, sem texto antes ou depois.

Legendas:
${legendas}

Como ler as legendas (gírias comuns):
- X = check, C = call, B = bet, R = raise, F = fold. "X/C" = check e depois call. "cbet 1/3 C" = vilão fez cbet de 1/3 do pote e o hero pagou.
- "lead" = hero, fora de posição, aposta primeiro depois de ter só pagado na street anterior.
- "call?" / "lead?" / "3bet?" = a dúvida daquele momento.
- "900 left itm 1500" = 900 jogadores restantes, premiação começa em 1500 (ou seja, já está no dinheiro). Isso é contexto de ICM: vai para o resumo.
- Legendas descrevem ações que NÃO aparecem no print (aconteceram antes ou depois). Considere-as verdadeiras.

Como ler a mesa:
- O hero é o jogador embaixo, com as cartas viradas para cima${heroNicks?.length ? ` (nick: ${heroNicks.join(", ")})` : ""}.
- Jogador SEM cartas na frente já foldou. Fichas paradas na frente de quem foldou são blind ou aposta morta e NÃO tornam o pote multiway. Conte como ativos só os jogadores com cartas.
- NAIPES: baralho de 4 cores. Decida o naipe pela COR da carta: verde = ♣, azul = ♦, vermelho = ♥, preto/cinza = ♠. Confira cada carta, uma por uma.
- Posições possíveis: ${positions.join(", ")}. O botão do dealer é o disco com "D" (às vezes vermelho ou branco) perto de um jogador: ele é o BTN. Em sentido horário a partir do BTN: SB (quem tem 0.5bb no pré-flop), BB (quem tem 1bb), depois as demais até o CO. Mesa de 9: BTN, SB, BB, UTG, UTG+1, UTG+2, LJ, HJ, CO. Mesa de 8: BTN, SB, BB, UTG, UTG+1, LJ, HJ, CO. Com menos jogadores, somem as primeiras depois do BB.
- Stacks e potes aparecem em BB.
- Salas possíveis: ${sites.join(", ")}. O nome do torneio fica no título da janela.

Dúvidas:
- Em regra, crie UMA dúvida por print, ligada a ele pelo número. Se um print claramente não tiver dúvida (só mostra contexto), não crie dúvida para ele. Se não houver nenhuma legenda, crie uma dúvida para cada momento de decisão diferente mostrado.
- Spots possíveis: ${tags.join(" | ")}.
  Exemplos: "lead" = aposta do hero fora de posição como primeiro a agir após ter pagado; "call vs barril turn/river" = hero enfrentando aposta no turn ou river depois de ter pagado antes; "bluff catch" = pagar aposta grande no river com mão que só ganha de blefe; "3bet" e "iso" são decisões pré-flop.
  Marque só o que se encaixa claramente. Na dúvida, não marque.
- Nunca invente valores que não estão visíveis: use null.`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "missing_key" });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return res.status(401).json({ error: "unauthorized" });
  } catch {
    return res.status(502).json({ error: "auth_unreachable" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const images = Array.isArray(body.images) ? body.images.filter(x => typeof x === "string").slice(0, 8) : [];
  if (!images.length) return res.status(400).json({ error: "no_images" });
  const captionsIn = Array.isArray(body.captions) ? body.captions : [];
  const ctx = {
    sites: Array.isArray(body.sites) ? body.sites.slice(0, 30) : [],
    positions: Array.isArray(body.positions) ? body.positions.slice(0, 12) : [],
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 80) : [],
    heroNicks: Array.isArray(body.heroNicks) ? body.heroNicks.slice(0, 10) : [],
    captions: images.map((_, i) => String(captionsIn[i] || "").slice(0, 300).trim())
  };

  const content = [];
  images.forEach((data, i) => {
    content.push({ type: "text", text: `Print ${i + 1}${ctx.captions[i] ? ` — legenda: "${ctx.captions[i]}"` : ""}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  });
  content.push({ type: "text", text: prompt(ctx) });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        tools: [TOOL],
        // alguns modelos novos não aceitam forçar a ferramenta; pedimos no texto e lemos JSON como plano B
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "ai_error", detail: j?.error?.message || `HTTP ${r.status}` });
    let out = (j.content || []).find(c => c.type === "tool_use")?.input;
    // às vezes listas chegam como texto JSON
    if (out && typeof out.decisions === "string") { try { out.decisions = JSON.parse(out.decisions); } catch { out.decisions = []; } }
    if (!out) {
      const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
    }
    if (!out) return res.status(502).json({ error: "ai_error", detail: "a IA respondeu sem os dados da mão; tente de novo" });
    // limpa o que vier fora das listas
    if (out.site && !ctx.sites.includes(out.site)) out.site = null;
    if (out.position && !ctx.positions.includes(out.position)) out.position = null;
    out.decisions = (Array.isArray(out.decisions) ? out.decisions : []).slice(0, 12).map(d => ({
      print: Number.isInteger(d.print) && d.print >= 1 && d.print <= images.length ? d.print : null,
      street: STREETS.includes(d.street) ? d.street : null,
      situation: d.situation || null,
      question: d.question || null,
      tags: (Array.isArray(d.tags) ? d.tags : []).filter(t => ctx.tags.includes(t)).slice(0, 2)
    }));
    out.model = MODEL;
    out.stop_reason = j.stop_reason;
    out.usage = j.usage;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "ai_unreachable", detail: String(e?.message || e) });
  }
};
