// Registra quanto cada pessoa gastou de IA (tokens e custo estimado). Só o admin vê o resumo.
// O arquivo começa com "_" para a Vercel não publicar como endereço.
const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";

// US$ por milhão de tokens (preços oficiais em nov/2026)
const PRICES = {
  "claude-haiku-5-5": (inp) => inp > 100000 ? [0.5, 2.5] : [0.1, 0.5],
  "claude-sonnet-5-5": () => [2, 10]
};
function costOf(model, usage) {
  const inp = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  const out = usage?.output_tokens || 0;
  const key = Object.keys(PRICES).find(k => String(model).startsWith(k)) || "claude-sonnet-5-5";
  const [pi, po] = PRICES[key](inp);
  return { inp, out, cost: (inp * pi + out * po) / 1e6 };
}
async function logUsage(token, kind, model, usage) {
  try {
    const { inp, out, cost } = costOf(model, usage);
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind, model, input_tokens: inp, output_tokens: out, cost_usd: Math.round(cost * 1e6) / 1e6 })
    });
  } catch { /* registrar o gasto nunca pode atrapalhar a leitura */ }
}
module.exports = { logUsage, costOf };
