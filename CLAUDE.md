# Diário de Mesa: contexto para quem for mexer no código

Site pessoal (um único usuário, jogador profissional de poker, MTT) para organizar agenda, tarefas, pré-grind, biblioteca de mãos com prints, dúvidas para o plantão do time e leaks.

## Stack
- Frontend estático, sem build e sem dependências: `index.html`, `css/app.css`, `js/app.js` (módulo ES), `js/config.js`.
- supabase-js via CDN (jsDelivr, versão fixada no `index.html`).
- Banco, login e imagens: Supabase (projeto `setfwqbgnrdqjhdyyrwm`, região São Paulo). Estrutura em `supabase/schema.sql`; mudanças incrementais em `supabase/migrations/`, que o dono roda à mão no SQL Editor.
- Hospedagem: Vercel, com deploy automático a cada push na `main`. URL: https://diario-de-mesa-gamma.vercel.app
- Função serverless `api/analyze.js` (CommonJS, sem dependências): lê prints com a API da Anthropic (modelo padrão `claude-sonnet-5-5`, trocável pela env `ANTHROPIC_MODEL`). Recebe os prints com as legendas e devolve os dados da mão e uma lista de dúvidas (uma por print). Exige a env `ANTHROPIC_API_KEY` e um token de login válido do Supabase.

- Função `api/hrc.js`: leituras sob demanda para o HRC. `mode: payouts` lê as faixas de premiação do print do lobby (Haiku); `mode: table` lê a mesa (Sonnet). O navegador (`js/hrc.js`, código puro) monta o .json no formato SharkScope (que o HRC importa) e um histórico de mão no formato PokerStars (para colar no HRC). Os resultados ficam salvos em `hands.hrc_payouts` e `hands.hrc_table`. Bounty PKO: as salas mostram metade (parte paga na eliminação) e o histórico PokerStars leva o total, então o valor lido é dobrado, exceto nas salas de `PKO_SHOWS_FULL_BOUNTY` em `js/config.js` (hoje só CoinPoker).

## Contas e grupo (etapa 1 do swap)
- Várias contas, cadastro fechado: só entra quem o admin convida em Ajustes → Membros (função `api/admin.js`, que usa a env `SUPABASE_SECRET_KEY` só no servidor e confere se quem chama é admin). Remover = sai do grupo e o login é bloqueado (dados ficam guardados).
- Tabelas `profiles` (nick, cor, `room_nicks` = nicks nas salas, usados pela IA), `groups`, `group_members` (`role` admin/membro). Funções `is_group_member`, `shares_group_with`, `is_admin`. Perfis são visíveis para quem está no mesmo grupo.
- Espaço pessoal continua 100% privado por dono (nem o admin vê as mãos dos outros). O fórum (etapa 2) vai mostrar só o que for postado com "Postar no swap".
- Primeiro acesso: o link do convite abre a tela de escolher nick e senha (`#setpass`); "Esqueci minha senha" usa o mesmo fluxo (type=recovery).
- `ai_usage`: cada chamada de IA registra tokens e custo estimado (`api/_usage.js`, preços Sonnet 5.5 US$2/10 e Haiku 5.5 US$0,10/0,50 por milhão). Só o admin vê, pela função `admin_stats` (que também devolve armazenamento e tamanho do banco). Aviso no topo para o admin acima de 80% do plano grátis.

## Fórum do swap (etapa 2, parte 1)
- Tabela `posts` (uma dúvida postada num grupo) e `post_views` (visto por). Regras: o grupo lê só dúvidas postadas e a mão/prints/comentários delas (`decision_visible`, `hand_visible`, `forum_allows` no storage); membros comentam em posts; o dono da dúvida fixa comentários de qualquer um (gatilho `comments_guard` impede mudar o texto dos outros); admin tira posts do ar e apaga comentários de posts. A regra antiga `dono` de comments foi trocada por regras separadas (antes dava para comentar em dúvida alheia).
- No navegador, dados pessoais são carregados com `eq("user_id", eu)`; o que veio do fórum fica em `FX` (posts, decisions, hands, images, views). Use `getDec`, `getHand`, `imagesOf`, `decisionsOf` (olham os dois). A página da dúvida (`renderDoubt`) serve para as minhas e para posts dos outros (`mine` esconde resolver/plantão/HRC/compartilhar/editar/fixar).
- Tela `#forum` com busca e filtros (todos, não vistos, abertos, resolvidos, autor, spot); selo de não vistos no menu; atualiza a cada 60s.

## Fórum do swap (etapa 2, partes 2 e 3, migração 010)
- `reactions` (👍 concordo, 👎 discordo, 🤔 duvida, 🔥 otima, 📌 rever; na dúvida com `comment_id` null ou num comentário). Só em posts. Filtro "📌 Rever depois" no fórum.
- `notifications`: criados por gatilhos no banco (`notify_comment`: comentário no meu post, resposta numa discussão em que participei, `@nick` no texto; `notify_reaction`). Post novo não vira aviso (o selo do fórum já mostra). A tela Avisos junta `notifications` + `share_comments`; abrir a dúvida marca os dois como lidos.
- Menções: chips "Marcar: @nick" no comentário; `bodyHtml` realça os nicks.
- Votação às cegas: `polls` (2–6 opções, só o autor cria/revela/apaga) e `poll_votes` (1 voto). Os votos dos outros só aparecem (RLS + `poll_open`) para quem já votou, quando todos menos o autor votaram, ou quando o autor revela. `poll_voters` diz quem votou sem dizer em quê.
- Spoiler: nos posts dos outros, conclusão e discussão ficam escondidas até clicar, votar ou comentar (`post_views.revealed`). No link público (`ver.html`) o mesmo, guardado em localStorage `dm-rev-<token>`; o PDF mostra tudo.

## Modelo de dados
- `hands`: dados da mão (sala, torneio, cartas, posição, stack inicial, board final, `situation` = resumo/história).
- `hand_images`: prints da mão (`kind` = `mesa` ou `lobby`; prints com legenda começando por "lobby" viram `lobby` e a IA da mão ignora), com `caption` (legenda curta do jogador, estilo "cbet 1/3 C. Lead?").
- `decisions`: as dúvidas da mão, uma por momento/print (`image_id`, street, situação, pergunta, spots, conclusão, status, plantão, leak). A biblioteca e o plantão mostram um card por dúvida.
- `comments`: discussão de cada dúvida (texto, `images` = caminhos no bucket em `<user_id>/comments/<decision_id>/`, `pinned` = conclusão).
- Telas: a Biblioteca lista dúvidas agrupadas pelo dia de envio da mão (`hands.created_at`), com seções que abrem/fecham (estado em localStorage `dm-dias`); só aparecem dias com mãos; clicar abre a tela da dúvida (`#duvida-<id>`) com print, discussão, resolver/reabrir e modo apresentar. O editor (diálogo) é só para criar ou editar a mão. No editor, a IA só lê os prints quando o usuário clica em "Ler com IA" (nada automático), e há um espaço para colar o print do lobby (salvo como `kind = lobby`).
- Status das dúvidas no banco: `rever` (aberta) e `revisada` (resolvida).
- As colunas question/tags/conclusion/plantao/leak_id em `hands` são legado: foram migradas para `decisions` e não são mais usadas.

## Atalho no PC (pasta `pc/`)
- `pc/DiarioDeMesa-Atalho.ps1` (PowerShell 5.1, salvo em UTF-8 com BOM): registra Win+Shift+A (print, junta em até 1 min), Win+Shift+Z (mão nova) e Win+Shift+X (lobby), com alternativas automáticas se estiverem ocupados. Abre o recorte do Windows (`ms-screenclip:`), envia a imagem direto ao Supabase com sessão própria (refresh token guardado com DPAPI em `%APPDATA%\DiarioDeMesa`), cria `hands` com `status = inbox` e `source = atalho`. Não usa IA.
- `Iniciar atalho.vbs` roda escondido; `Iniciar com o Windows.cmd` cria o atalho de inicialização.
- No site, a Caixa de entrada (`#entrada`) lista as mãos `inbox`; a biblioteca as ignora. Salvar a mão no editor tira ela da caixa. "Enviar todas para a biblioteca" cria uma dúvida por print (legenda = pergunta, sem IA) e muda `status` para `rever`; "Descartar todas" apaga as mãos e os prints. Cada card da caixa mostra a tira de prints com ✂ entre eles (separa daquele print em diante numa mão nova) e "Juntar com a anterior" (move os prints para a mão enviada antes).

## Compartilhar
- Tabela `shares` (token aleatório, `decision_ids`, `revoked`). Link público `/c/<token>` (rewrite em `vercel.json` para `ver.html`), que usa a função `get_share` (security definer, liberada para `anon`) e a regra de storage `prints compartilhados` (`share_allows`): visitantes veem só prints de mesa (não lobby) e prints de comentários fixados das dúvidas de links ativos. A página tem "Baixar PDF" (window.print com CSS de impressão).
- No site: botão "🔗 Compartilhar" na dúvida; "Compartilhar várias" na biblioteca (seleção por card ou por dia); lista com copiar/desativar em Ajustes. O link é copiado antes de salvar (o navegador só deixa copiar logo após o clique).

- Comentários dos amigos: tabela `share_comments` (dono = `owner_id`, `pin_id` = conclusão comentada ou null = geral, `read`). Visitantes comentam pela função `add_share_comment` (confere link ativo, dúvida do link, conclusão fixada válida, nome 1–40, texto 1–2000, limite de 30 por link a cada 10 min). O dono responde direto na tabela (`is_owner = true`, nome = `HERO_NICKS[0]`).
- No site: tela Avisos (`#avisos`, sino com contador de não lidos), card "Comentários dos amigos" na dúvida (por conclusão + gerais, responder/excluir), selo "💬 N novos" nos cards; abrir a dúvida marca como lido. Atualiza a cada 60s e ao voltar para a aba.

## Janelas
- Todas as janelas (`<dialog>`) fecham ao clicar fora ou com Esc. Janelas com formulário registram uma verificação em `dirtyChecks`; se houver alteração não salva, aparece o aviso "Descartar / Continuar editando" em vez de fechar.

## Regras
- Todas as tabelas têm RLS `user_id = auth.uid()`. Prints ficam no bucket privado `hands`, em `<user_id>/<hand_id>/arquivo.jpg`.
- Cadastro de novos usuários desligado no Supabase.
- Interface em português do Brasil, tema escuro, menu lateral.
- Salas usadas: PokerStars, GGPoker, CoinPoker, PartyPoker, iPoker, Bodog, YaPoker. Nicks nas salas vêm do perfil de cada um (`room_nicks`); o do dono é sluizg.
- Ao adicionar uma coluna: atualizar `schema.sql`, criar `supabase/migrations/NNN_nome.sql` e avisar o dono para rodar.

## Próximos passos combinados
- Etapa 3: pauta do plantão (marcadas, ordenadas por votos, sai sozinha depois de respondida), treino com revisão espaçada usando as mãos resolvidas do grupo, agenda do grupo como camada opcional.
- Não fazer: controle financeiro do swap (o time já tem), avisos no Discord, app de celular, painel de spots, limite de IA por pessoa.
