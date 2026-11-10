// Preencha com os dados do seu projeto Supabase:
// Supabase → Project Settings → API → "Project URL" e "anon public key".
// A chave "anon" é pública por natureza: a segurança vem das regras do banco (schema.sql).
export const SUPABASE_URL = "COLE_AQUI_A_PROJECT_URL";
export const SUPABASE_ANON_KEY = "COLE_AQUI_A_ANON_KEY";

export const SITES = ["PokerStars", "GGPoker", "CoinPoker", "PartyPoker", "iPoker", "Bodog", "YaPoker"];
export const POSITIONS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
export const DEFAULT_TAGS = [
  "call vs barril turn/river", "iso", "3bet", "4bet / squeeze", "lead", "3-barril",
  "cbet size alto BW", "bluff catch", "push/fold", "ICM / HRC", "equilab", "random"
];
