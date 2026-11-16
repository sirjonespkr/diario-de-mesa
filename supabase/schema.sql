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
