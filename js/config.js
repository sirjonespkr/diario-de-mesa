// Preencha com os dados do seu projeto Supabase:
// Supabase → Project Settings → API → "Project URL" e "anon public key".
// A chave "anon" é pública por natureza: a segurança vem das regras do banco (schema.sql).
export const SUPABASE_URL = "https://setfwqbgnrdqjhdyyrwm.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_pgZwjSF38yBhEQo1B0AmRQ_JSn2O374";

export const SITES = ["PokerStars", "GGPoker", "CoinPoker", "PartyPoker", "iPoker", "Bodog", "YaPoker"];
export const POSITIONS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
export const DEFAULT_TAGS = [
  "call vs barril turn/river", "iso", "3bet", "4bet / squeeze", "lead", "3-barril",
  "cbet size alto BW", "bluff catch", "push/fold", "ICM / HRC", "equilab", "random"
];

// Seus nicks nas salas: ajudam a IA a saber quem é você na mesa.
export const HERO_NICKS = ["sluizg"];

// Bounty progressivo (PKO): a maioria das salas mostra na mesa só a parte que você ganha ao eliminar (metade).
// O histórico do PokerStars espera o bounty TOTAL, então o site dobra o valor lido.
// Salas que já mostram o bounty inteiro na mesa (não dobra):
export const PKO_SHOWS_FULL_BOUNTY = ["CoinPoker"];
