# Diário de Mesa: contexto para quem for mexer no código

Site pessoal (um único usuário, jogador profissional de poker, MTT) para organizar agenda, tarefas, pré-grind, biblioteca de mãos com prints, dúvidas para o plantão do time e leaks.

## Stack
- Frontend estático, sem build e sem dependências: `index.html`, `css/app.css`, `js/app.js` (módulo ES), `js/config.js`.
- supabase-js via CDN (jsDelivr, versão fixada no `index.html`).
- Banco, login e imagens: Supabase (projeto `setfwqbgnrdqjhdyyrwm`, região São Paulo). Estrutura em `supabase/schema.sql`; mudanças incrementais em `supabase/migrations/`, que o dono roda à mão no SQL Editor.
- Hospedagem: Vercel, com deploy automático a cada push na `main`. URL: https://diario-de-mesa-gamma.vercel.app
- Função serverless `api/analyze.js` (CommonJS, sem dependências): lê prints com a API da Anthropic (modelo padrão `claude-haiku-5-5`, trocável pela env `ANTHROPIC_MODEL`) e devolve os campos da mão. Exige a env `ANTHROPIC_API_KEY` e um token de login válido do Supabase.

## Regras
- Todas as tabelas têm RLS `user_id = auth.uid()`. Prints ficam no bucket privado `hands`, em `<user_id>/<hand_id>/arquivo.jpg`.
- Cadastro de novos usuários desligado no Supabase.
- Interface em português do Brasil, tema escuro, menu lateral.
- Salas usadas: PokerStars, GGPoker, CoinPoker, PartyPoker, iPoker, Bodog, YaPoker. Nick do hero: sluizg.
- Ao adicionar uma coluna: atualizar `schema.sql`, criar `supabase/migrations/NNN_nome.sql` e avisar o dono para rodar.

## Próximos passos combinados
- Sessões de grind (lucro, ROI, ABI, $/h).
- Atalho no PC que envia o print direto, sem precisar colar no site.
- Agrupar automaticamente prints da mesma mão.
