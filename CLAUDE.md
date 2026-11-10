# Diário de Mesa: contexto para quem for mexer no código

Site pessoal (um único usuário, jogador profissional de poker, MTT) para organizar agenda, tarefas, pré-grind, biblioteca de mãos com prints, dúvidas para o plantão do time e leaks.

## Stack
- Frontend estático, sem build e sem dependências: `index.html`, `css/app.css`, `js/app.js` (módulo ES), `js/config.js`.
- supabase-js via CDN (jsDelivr, versão fixada no `index.html`).
- Banco, login e imagens: Supabase (projeto `setfwqbgnrdqjhdyyrwm`, região São Paulo). Estrutura em `supabase/schema.sql`; mudanças incrementais em `supabase/migrations/`, que o dono roda à mão no SQL Editor.
- Hospedagem: Vercel, com deploy automático a cada push na `main`. URL: https://diario-de-mesa-gamma.vercel.app
- Função serverless `api/analyze.js` (CommonJS, sem dependências): lê prints com a API da Anthropic (modelo padrão `claude-sonnet-5-5`, trocável pela env `ANTHROPIC_MODEL`). Recebe os prints com as legendas e devolve os dados da mão e uma lista de dúvidas (uma por print). Exige a env `ANTHROPIC_API_KEY` e um token de login válido do Supabase.

- Função `api/hrc.js`: leituras sob demanda para o HRC. `mode: payouts` lê as faixas de premiação do print do lobby (Haiku); `mode: table` lê a mesa (Sonnet). O navegador (`js/hrc.js`, código puro) monta o .json no formato SharkScope (que o HRC importa) e um histórico de mão no formato PokerStars (para colar no HRC). Os resultados ficam salvos em `hands.hrc_payouts` e `hands.hrc_table`. Bounty PKO: as salas mostram metade (parte paga na eliminação) e o histórico PokerStars leva o total, então o valor lido é dobrado, exceto nas salas de `PKO_SHOWS_FULL_BOUNTY` em `js/config.js` (hoje só CoinPoker).

## Modelo de dados
- `hands`: dados da mão (sala, torneio, cartas, posição, stack inicial, board final, `situation` = resumo/história).
- `hand_images`: prints da mão (`kind` = `mesa` ou `lobby`; prints com legenda começando por "lobby" viram `lobby` e a IA da mão ignora), com `caption` (legenda curta do jogador, estilo "cbet 1/3 C. Lead?").
- `decisions`: as dúvidas da mão, uma por momento/print (`image_id`, street, situação, pergunta, spots, conclusão, status, plantão, leak). A biblioteca e o plantão mostram um card por dúvida.
- `comments`: discussão de cada dúvida (texto, `images` = caminhos no bucket em `<user_id>/comments/<decision_id>/`, `pinned` = conclusão).
- Telas: a Biblioteca lista dúvidas; clicar abre a tela da dúvida (`#duvida-<id>`) com print, discussão, resolver/reabrir e modo apresentar. O editor (diálogo) é só para criar ou editar a mão. No editor, a IA só lê os prints quando o usuário clica em "Ler com IA" (nada automático), e há um espaço para colar o print do lobby (salvo como `kind = lobby`).
- Status das dúvidas no banco: `rever` (aberta) e `revisada` (resolvida).
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
