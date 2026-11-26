-- Diário de Mesa — estrutura do banco
-- Cole tudo isto em Supabase → SQL Editor → New query → Run.
-- Pode rodar de novo sem problema: só cria o que ainda não existe.

create extension if not exists pgcrypto;

-- Tags de spot (ex.: 3bet, iso, call vs barril)
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Leaks que você identificou
create table if not exists leaks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  description text,
  status text not null default 'ativo' check (status in ('ativo', 'corrigido')),
  created_at timestamptz not null default now()
);

-- Mãos (biblioteca)
create table if not exists hands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  played_on date default current_date,
  site text,
  tournament text,
  hero_cards text,
  position text,
  stack_bb numeric,
  board text,
  situation text,
  tags text[] not null default '{}',
  question text,
  conclusion text,
  status text not null default 'rever' check (status in ('inbox', 'rever', 'revisada')),
  plantao boolean not null default false,
  plantao_answer text,
  leak_id uuid references leaks on delete set null,
  source text not null default 'manual'
);
create index if not exists hands_user_created on hands (user_id, created_at desc);

-- Prints de cada mão (os arquivos ficam no Storage, bucket "hands")
create table if not exists hand_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  hand_id uuid not null references hands on delete cascade,
  path text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists hand_images_hand on hand_images (hand_id);

-- Agenda
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  day date not null,
  start_time text,
  end_time text,
  category text not null default 'grind',
  note text,
  created_at timestamptz not null default now()
);

-- Tarefas
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null,
  category text not null default 'grind',
  done boolean not null default false,
  done_on date,
  created_at timestamptz not null default now()
);

-- Checklist do pré-grind
create table if not exists pregrind (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- Segurança: cada linha só é visível e editável pelo próprio dono
do $$
declare t text;
begin
  foreach t in array array['tags','leaks','hands','hand_images','events','tasks','pregrind'] loop
    execute format('alter table %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'dono') then
      execute format('create policy dono on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    end if;
  end loop;
end $$;

-- Bucket privado para os prints
insert into storage.buckets (id, name, public)
values ('hands', 'hands', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'prints do dono') then
    create policy "prints do dono" on storage.objects for all
      using (bucket_id = 'hands' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'hands' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ===== Migração 003 (legendas e dúvidas) =====
-- Legendas nos prints + várias dúvidas por mão.
-- Pode rodar mais de uma vez sem problema.

alter table hand_images add column if not exists caption text;

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  hand_id uuid not null references hands on delete cascade,
  image_id uuid references hand_images on delete set null,
  sort int not null default 0,
  street text check (street in ('preflop', 'flop', 'turn', 'river')),
  situation text,
  question text,
  tags text[] not null default '{}',
  conclusion text,
  status text not null default 'rever' check (status in ('rever', 'revisada')),
  plantao boolean not null default false,
  plantao_answer text,
  leak_id uuid references leaks on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists decisions_hand on decisions (hand_id);

alter table decisions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'decisions' and policyname = 'dono') then
    create policy dono on decisions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- Mãos já salvas viram uma mão com uma dúvida
insert into decisions (user_id, hand_id, situation, question, tags, conclusion, status, plantao, plantao_answer, leak_id)
select h.user_id, h.id, h.situation, h.question, h.tags, h.conclusion,
       case when h.status = 'revisada' then 'revisada' else 'rever' end,
       h.plantao, h.plantao_answer, h.leak_id
from hands h
where not exists (select 1 from decisions d where d.hand_id = h.id);

-- ===== Migração 004 (comentários) =====
-- Discussão de cada dúvida: comentários com texto e prints, que podem ser fixados como conclusão.
-- Pode rodar mais de uma vez sem problema.

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  decision_id uuid not null references decisions on delete cascade,
  body text,
  images text[] not null default '{}',
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists comments_decision on comments (decision_id, created_at);

alter table comments enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'dono') then
    create policy dono on comments for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ===== Migração 005 (HRC) =====
-- HRC: print do lobby separado dos prints da mão + resultados salvos para não gastar IA de novo.
-- Pode rodar mais de uma vez sem problema.

alter table hand_images add column if not exists kind text not null default 'mesa';
alter table hands add column if not exists hrc_payouts jsonb;
alter table hands add column if not exists hrc_table jsonb;

-- ===== Migração 006 (links compartilhados) =====
-- Links de compartilhamento: uma página pública (só leitura) com dúvidas escolhidas.
-- Quem tem o link vê os prints da mão, a pergunta, o resumo e a conclusão. Nada mais.
-- Pode rodar mais de uma vez sem problema.

create table if not exists shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  token text not null unique,
  title text,
  decision_ids uuid[] not null default '{}',
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
alter table shares enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'shares' and policyname = 'dono') then
    create policy dono on shares for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- Dados de um link (para visitantes sem conta). Só devolve o que foi compartilhado e se o link estiver ativo.
create or replace function public.get_share(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'title', s.title,
    'created_at', s.created_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'street', d.street, 'situation', d.situation, 'question', d.question,
        'tags', d.tags, 'conclusion', d.conclusion, 'image_id', d.image_id, 'status', d.status,
        'hand', jsonb_build_object('site', h.site, 'tournament', h.tournament, 'hero_cards', h.hero_cards,
          'position', h.position, 'stack_bb', h.stack_bb, 'board', h.board, 'summary', h.situation, 'played_on', h.played_on),
        'images', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'path', i.path, 'caption', i.caption) order by i.sort)
                            from hand_images i where i.hand_id = h.id and i.kind <> 'lobby'), '[]'::jsonb),
        'pins', coalesce((select jsonb_agg(jsonb_build_object('body', c.body, 'images', c.images) order by c.created_at)
                          from comments c where c.decision_id = d.id and c.pinned), '[]'::jsonb)
      ) order by array_position(s.decision_ids, d.id))
      from decisions d join hands h on h.id = d.hand_id
      where d.id = any(s.decision_ids) and d.user_id = s.user_id
    ), '[]'::jsonb)
  )
  from shares s
  where s.token = p_token and not s.revoked;
$$;
grant execute on function public.get_share(text) to anon, authenticated;

-- Um print pode ser aberto por visitantes só se fizer parte de um link ativo.
create or replace function public.share_allows(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from shares s
    join decisions d on d.id = any(s.decision_ids) and d.user_id = s.user_id
    where not s.revoked and (
      exists (select 1 from hand_images i where i.hand_id = d.hand_id and i.kind <> 'lobby' and i.path = p_path)
      or exists (select 1 from comments c where c.decision_id = d.id and c.pinned and p_path = any(c.images))
    )
  );
$$;
grant execute on function public.share_allows(text) to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'prints compartilhados') then
    create policy "prints compartilhados" on storage.objects for select to anon, authenticated
      using (bucket_id = 'hands' and public.share_allows(name));
  end if;
end $$;

-- ===== Migração 007 (comentários dos amigos) =====
-- Comentários dos amigos nas páginas compartilhadas (por conclusão ou gerais) + respostas do dono.
-- Pode rodar mais de uma vez sem problema.

create table if not exists share_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  share_id uuid references shares on delete set null,
  decision_id uuid not null references decisions on delete cascade,
  pin_id uuid references comments on delete set null,
  author_name text not null,
  is_owner boolean not null default false,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists share_comments_decision on share_comments (decision_id, created_at);
create index if not exists share_comments_owner on share_comments (owner_id, read);
alter table share_comments enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'share_comments' and policyname = 'dono') then
    create policy dono on share_comments for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  end if;
end $$;

-- Visitante comenta pelo link (sem conta). Confere link ativo, dúvida do link, conclusão válida e limites.
create or replace function public.add_share_comment(p_token text, p_decision uuid, p_pin uuid, p_name text, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s shares%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_body text := btrim(coalesce(p_body, ''));
  r share_comments%rowtype;
begin
  select * into s from shares where token = p_token and not revoked;
  if not found then raise exception 'link inválido ou desativado'; end if;
  if not (p_decision = any(s.decision_ids)) then raise exception 'dúvida não faz parte deste link'; end if;
  if p_pin is not null and not exists (select 1 from comments where id = p_pin and decision_id = p_decision and pinned) then
    raise exception 'conclusão não encontrada';
  end if;
  if length(v_name) < 1 or length(v_name) > 40 then raise exception 'nome precisa ter de 1 a 40 caracteres'; end if;
  if length(v_body) < 1 or length(v_body) > 2000 then raise exception 'comentário precisa ter de 1 a 2000 caracteres'; end if;
  if (select count(*) from share_comments where share_id = s.id and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'muitos comentários em pouco tempo; tente daqui a alguns minutos';
  end if;
  insert into share_comments (owner_id, share_id, decision_id, pin_id, author_name, body)
  values (s.user_id, s.id, p_decision, p_pin, v_name, v_body)
  returning * into r;
  return jsonb_build_object('id', r.id, 'created_at', r.created_at);
end $$;
grant execute on function public.add_share_comment(text, uuid, uuid, text, text) to anon, authenticated;

-- get_share agora devolve o id de cada conclusão e os comentários dos amigos.
create or replace function public.get_share(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'title', s.title,
    'created_at', s.created_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'street', d.street, 'situation', d.situation, 'question', d.question,
        'tags', d.tags, 'conclusion', d.conclusion, 'image_id', d.image_id, 'status', d.status,
        'hand', jsonb_build_object('site', h.site, 'tournament', h.tournament, 'hero_cards', h.hero_cards,
          'position', h.position, 'stack_bb', h.stack_bb, 'board', h.board, 'summary', h.situation, 'played_on', h.played_on),
        'images', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'path', i.path, 'caption', i.caption) order by i.sort)
                            from hand_images i where i.hand_id = h.id and i.kind <> 'lobby'), '[]'::jsonb),
        'pins', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'images', c.images) order by c.created_at)
                          from comments c where c.decision_id = d.id and c.pinned), '[]'::jsonb),
        'friend_comments', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'pin_id', f.pin_id, 'author_name', f.author_name,
                                       'is_owner', f.is_owner, 'body', f.body, 'created_at', f.created_at) order by f.created_at)
                                     from share_comments f where f.decision_id = d.id), '[]'::jsonb)
      ) order by array_position(s.decision_ids, d.id))
      from decisions d join hands h on h.id = d.hand_id
      where d.id = any(s.decision_ids) and d.user_id = s.user_id
    ), '[]'::jsonb)
  )
  from shares s
  where s.token = p_token and not s.revoked;
$$;
grant execute on function public.get_share(text) to anon, authenticated;

-- ===== Migração 008 (perfis, grupo, uso de IA) =====
-- Etapa 1 do swap: perfis, grupo com membros, gasto de IA por pessoa e estatísticas para o admin.
-- O espaço pessoal de cada um continua privado (todas as tabelas antigas já filtram por dono).
-- Pode rodar mais de uma vez sem problema.

-- ---------- perfis ----------
create table if not exists profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  nick text,
  color text,
  room_nicks text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------- grupo e membros ----------
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists group_members (
  group_id uuid not null references groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'membro' check (role in ('admin', 'membro')),
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- funções auxiliares (security definer para não entrar em loop com as regras de acesso)
create or replace function public.is_group_member(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where group_id = g and user_id = auth.uid());
$$;
create or replace function public.shares_group_with(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members a join group_members b on a.group_id = b.group_id
                 where a.user_id = auth.uid() and b.user_id = u);
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where user_id = auth.uid() and role = 'admin');
$$;

alter table profiles enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
do $$
begin
  -- perfil: cada um edita o seu; vê o seu e o de quem está no mesmo grupo
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'ver perfis do grupo') then
    create policy "ver perfis do grupo" on profiles for select using (user_id = auth.uid() or public.shares_group_with(user_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'criar o meu') then
    create policy "criar o meu" on profiles for insert with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'editar o meu') then
    create policy "editar o meu" on profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  -- grupo e membros: só leitura para quem é do grupo (convidar/remover é feito pela função de admin)
  if not exists (select 1 from pg_policies where tablename = 'groups' and policyname = 'membros veem') then
    create policy "membros veem" on groups for select using (public.is_group_member(id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'group_members' and policyname = 'membros veem') then
    create policy "membros veem" on group_members for select using (public.is_group_member(group_id));
  end if;
end $$;

-- ---------- gasto de IA por pessoa ----------
create table if not exists ai_usage (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text,
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_when on ai_usage (created_at);
alter table ai_usage enable row level security;
do $$
begin
  -- cada um só registra o próprio uso; ninguém lê direto (o admin vê pelo resumo abaixo)
  if not exists (select 1 from pg_policies where tablename = 'ai_usage' and policyname = 'registrar o meu') then
    create policy "registrar o meu" on ai_usage for insert with check (user_id = auth.uid());
  end if;
end $$;

-- ---------- estatísticas só para o admin ----------
create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then raise exception 'apenas o admin'; end if;
  return jsonb_build_object(
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'hands'),
    'db_bytes', pg_database_size(current_database()),
    'ai', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', t.user_id, 'nick', t.nick, 'month', t.month, 'calls', t.calls, 'cost', t.cost)
                       order by t.month desc, t.cost desc)
      from (
        select u.user_id, p.nick,
               to_char(date_trunc('month', u.created_at at time zone 'America/Sao_Paulo'), 'YYYY-MM') as month,
               count(*) as calls, round(sum(coalesce(u.cost_usd, 0)), 4) as cost
        from ai_usage u left join profiles p on p.user_id = u.user_id
        where u.created_at > now() - interval '3 months'
        group by u.user_id, p.nick, 3
      ) t
    ), '[]'::jsonb)
  );
end $$;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------- começo: cria o grupo "Swap" com você (a primeira conta do site) como admin ----------
insert into groups (name) select 'Swap' where not exists (select 1 from groups);
insert into group_members (group_id, user_id, role)
select (select id from groups order by created_at limit 1), u.id, 'admin'
from (select id from auth.users order by created_at limit 1) u
where not exists (select 1 from group_members);
insert into profiles (user_id, nick, room_nicks)
select u.id, split_part(u.email, '@', 1), '{sluizg}'
from (select id, email from auth.users order by created_at limit 1) u
on conflict (user_id) do nothing;
