# Diário de Mesa

Site pessoal de organização para poker: agenda, tarefas, pré-grind, biblioteca de mãos com prints, plantão e leaks.

- **Frontend:** HTML, CSS e JavaScript puros, sem etapa de build e sem dependências para atualizar.
- **Banco, login e imagens:** Supabase.
- **Hospedagem:** Vercel. Cada alteração enviada ao GitHub publica o site sozinha.

## Instalação (uma vez só)

1. **Supabase → SQL Editor → New query:** cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
2. **Supabase → Project Settings → API:** copie a *Project URL* e a *anon public key* para `js/config.js`.
3. **Supabase → Authentication → URL Configuration:** em *Site URL*, coloque o endereço do site na Vercel.
4. **Vercel → Add New → Project:** importe este repositório. Não precisa mudar nenhuma configuração; é só clicar em **Deploy**.
5. Abra o site, digite e-mail e senha e clique em **Primeiro acesso? Criar minha conta**. Confirme o e-mail.
6. **Importante:** em **Supabase → Authentication → Sign In / Providers**, desligue *Allow new users to sign up*. Assim ninguém mais consegue criar conta no seu site.

## Estrutura

```
index.html          telas e diálogos
css/app.css         visual
js/config.js        chaves do Supabase, salas, posições, spots padrão
js/app.js           lógica do site
supabase/schema.sql tabelas, regras de segurança e bucket de prints
```

## Próximos passos planejados

- Sessões de grind (lucro, ROI, ABI, $/h).
- Automação de prints: atalho no PC que envia o print direto, IA que lê sala, torneio, cartas, board, stacks e posição e sugere o spot, e agrupamento de prints da mesma mão.
