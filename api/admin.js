// Ações do admin do swap: listar membros, convidar por e-mail, reenviar convite e remover.
// Precisa da variável de ambiente SUPABASE_SECRET_KEY na Vercel (a chave secreta do Supabase, nunca vai para o navegador).
// Só responde para quem é admin do grupo.

const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";
const SITE = "https://diario-de-mesa-gamma.vercel.app";

function svcHeaders(secret, extra = {}) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, "content-type": "application/json", ...extra };
}
async function svc(secret, path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers: svcHeaders(secret, opts.headers) });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = (body && (body.msg || body.message || body.error_description || body.error)) || `HTTP ${r.status}`;
    const e = new Error(msg); e.status = r.status; e.body = body; throw e;
  }
  return body;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return res.status(503).json({ error: "missing_secret" });

  // quem está chamando?
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  let me;
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return res.status(401).json({ error: "unauthorized" });
    me = await u.json();
  } catch { return res.status(502).json({ error: "auth_unreachable" }); }

  try {
    // é admin? de qual grupo?
    const adm = await svc(secret, `/rest/v1/group_members?user_id=eq.${me.id}&role=eq.admin&select=group_id&limit=1`);
    if (!adm?.length) return res.status(403).json({ error: "forbidden", detail: "apenas o admin" });
    const groupId = adm[0].group_id;

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = body.action;

    if (action === "members") {
      const members = await svc(secret, `/rest/v1/group_members?group_id=eq.${groupId}&select=user_id,role,created_at&order=created_at`);
      const ids = members.map(m => m.user_id);
      const profiles = ids.length ? await svc(secret, `/rest/v1/profiles?user_id=in.(${ids.join(",")})&select=user_id,nick,color`) : [];
      const out = [];
      for (const m of members) {
        let u = null;
        try { u = await svc(secret, `/auth/v1/admin/users/${m.user_id}`); } catch { }
        const p = profiles.find(x => x.user_id === m.user_id) || {};
        out.push({
          user_id: m.user_id, role: m.role, joined_at: m.created_at,
          email: u?.email || null, nick: p.nick || null, color: p.color || null,
          pending: !!u && !u.last_sign_in_at, last_sign_in_at: u?.last_sign_in_at || null,
          banned: !!(u?.banned_until && new Date(u.banned_until) > new Date())
        });
      }
      return res.status(200).json({ members: out });
    }

    if (action === "invite" || action === "resend") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", detail: "e-mail inválido" });
      let userId = null;
      try {
        const inv = await svc(secret, `/auth/v1/invite?redirect_to=${encodeURIComponent(SITE + "/")}`, { method: "POST", body: JSON.stringify({ email }) });
        userId = inv?.id || inv?.user?.id || null;
      } catch (e) {
        // já tem conta (ex.: já aceitou um convite antes): só garante que está no grupo
        if (e.status !== 422 && !/already|registered|exists/i.test(e.message)) throw e;
        const list = await svc(secret, `/auth/v1/admin/users?per_page=1000`);
        const found = (list.users || list || []).find(x => (x.email || "").toLowerCase() === email);
        if (!found) throw e;
        userId = found.id;
        if (found.banned_until) await svc(secret, `/auth/v1/admin/users/${userId}`, { method: "PUT", body: JSON.stringify({ ban_duration: "none" }) });
        if (action === "resend" && found.last_sign_in_at) return res.status(200).json({ ok: true, note: "essa pessoa já entrou no site; não precisa de convite" });
      }
      if (!userId) return res.status(502).json({ error: "invite_failed", detail: "o Supabase não devolveu o usuário" });
      await svc(secret, `/rest/v1/group_members?on_conflict=group_id,user_id`, {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ group_id: groupId, user_id: userId, role: "membro" })
      });
      await svc(secret, `/rest/v1/profiles?on_conflict=user_id`, {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ user_id: userId, nick: email.split("@")[0] })
      });
      return res.status(200).json({ ok: true, user_id: userId });
    }

    if (action === "remove") {
      const uid = String(body.user_id || "");
      if (!uid || uid === me.id) return res.status(400).json({ error: "bad_user", detail: "não dá para remover você mesmo" });
      await svc(secret, `/rest/v1/group_members?group_id=eq.${groupId}&user_id=eq.${uid}`, { method: "DELETE" });
      // bloqueia o login (os dados da pessoa ficam guardados, não são apagados)
      await svc(secret, `/auth/v1/admin/users/${uid}`, { method: "PUT", body: JSON.stringify({ ban_duration: "876000h" }) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "bad_action" });
  } catch (e) {
    return res.status(502).json({ error: "admin_error", detail: e.message || String(e) });
  }
};
