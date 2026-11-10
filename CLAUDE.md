# Diário de Mesa: contexto para quem for mexer no código

Site pessoal (um único usuário, jogador profissional de poker, MTT) para organizar agenda, tarefas, pré-grind, biblioteca de mãos com prints, dúvidas para o plantão do time e leaks.

## Stack
- Frontend estático, sem build e sem dependências: `index.html`, `css/app.css`, `js/app.js` (módulo ES), `js/config.js`.
- supabase-js via CDN (jsDelivr, versão fixada no `index.html`).
- Banco, login e imagens: Supabase (projeto `setfwqbgnrdqjhdyyrwm`, região São Paulo). Estrutura em `supabase/schema.sql`; mudanças incrementais em `supabase/migrations/`, que o dono roda à mão no SQL Editor.
- Hospedagem: Vercel, com deploy automático a cada push na `main`. URL: https://diario-de-mesa-gamma.vercel.app
- Função serverless `api/analyze.js` (CommonJS, sem dependências): lê prints com a API da Anthropic (modelo padrão `claude-sonnet-5-5`, trocável pela env `ANTHROPIC_MODEL`). Recebe os prints com as legendas e devolve os dados da mão e uma lista de dúvidas (uma por print). Exige a env `ANTHROPIC_API_KEY` e um token de login válido do Supabase.

## Modelo de dados
- `hands`: dados da mão (sala, torneio, cartas, posição, stack inicial, board final, `situation` = resumo/história).
- `hand_images`: prints da mão, com `caption` (legenda curta do jogador, estilo "cbet 1/3 C. Lead?").
- `decisions`: as dúvidas da mão, uma por momento/print (`image_id`, street, situação, pergunta, spots, conclusão, status, plantão, leak). A biblioteca e o plantão mostram um card por dúvida.
- As colunas question/tags/conclusion/plantao/leak_id em `hands` são legado: foram migradas para `decisions` e não são mais usadas.

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
