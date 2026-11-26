-- Fórum do swap, parte 1: postar uma dúvida no grupo, todos do grupo leem e comentam, "visto por".
-- Regra de ouro: só o que foi POSTADO fica visível para o grupo. O resto continua privado.
-- Pode rodar mais de uma vez sem problema.

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups on delete cascade,
  decision_id uuid not null unique references decisions on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists posts_group on posts (group_id, created_at desc);

create table if not exists post_views (
  decision_id uuid not null references decisions on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (decision_id, user_id)
);

-- ---------- funções auxiliares ----------
create or replace function public.decision_visible(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from posts p join group_members m on m.group_id = p.group_id
                 where p.decision_id = d and m.user_id = auth.uid());
$$;
create or replace function public.hand_visible(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from decisions dd join posts p on p.decision_id = dd.id join group_members m on m.group_id = p.group_id
                 where dd.hand_id = h and m.user_id = auth.uid());
$$;
create or replace function public.decision_owner(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from decisions where id = d and user_id = auth.uid());
$$;
create or replace function public.forum_allows(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from hand_images i where i.path = p_path and public.hand_visible(i.hand_id))
      or exists (select 1 from comments c where p_path = any(c.images) and public.decision_visible(c.decision_id));
$$;
grant execute on function public.decision_visible(uuid), public.hand_visible(uuid), public.decision_owner(uuid), public.forum_allows(text) to authenticated;

-- ---------- regras de acesso ----------
alter table posts enable row level security;
alter table post_views enable row level security;
do $$
begin
  -- posts: o grupo vê; cada um posta as próprias dúvidas no próprio grupo; tira do ar o autor ou o admin
  if not exists (select 1 from pg_policies where tablename = 'posts' and policyname = 'grupo vê') then
    create policy "grupo vê" on posts for select using (public.is_group_member(group_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'posts' and policyname = 'postar o meu') then
    create policy "postar o meu" on posts for insert with check (user_id = auth.uid() and public.is_group_member(group_id) and public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'posts' and policyname = 'tirar do ar') then
    create policy "tirar do ar" on posts for delete using (user_id = auth.uid() or (public.is_admin() and public.is_group_member(group_id)));
  end if;

  -- o grupo lê a dúvida postada, a mão dela e os prints
  if not exists (select 1 from pg_policies where tablename = 'decisions' and policyname = 'swap lê') then
    create policy "swap lê" on decisions for select using (public.decision_visible(id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'hands' and policyname = 'swap lê') then
    create policy "swap lê" on hands for select using (public.hand_visible(id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'hand_images' and policyname = 'swap lê') then
    create policy "swap lê" on hand_images for select using (public.hand_visible(hand_id));
  end if;

  -- comentários: a regra antiga "dono" deixava escrever em qualquer dúvida; troca por regras separadas
  if exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'dono') then
    drop policy dono on comments;
  end if;
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'meus: ver') then
    create policy "meus: ver" on comments for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'meus: editar') then
    create policy "meus: editar" on comments for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'meus: apagar') then
    create policy "meus: apagar" on comments for delete using (user_id = auth.uid());
  end if;

  -- discussão: o grupo lê e comenta nas postadas; o dono da dúvida vê e comenta em todas as suas
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'swap lê') then
    create policy "swap lê" on comments for select using (public.decision_visible(decision_id) or public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'swap comenta') then
    create policy "swap comenta" on comments for insert with check (user_id = auth.uid() and (public.decision_visible(decision_id) or public.decision_owner(decision_id)));
  end if;
  -- o dono da dúvida pode fixar/desafixar comentários de qualquer um (o gatilho abaixo impede mudar o texto dos outros)
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'dono da dúvida fixa') then
    create policy "dono da dúvida fixa" on comments for update using (public.decision_owner(decision_id)) with check (public.decision_owner(decision_id));
  end if;
  -- moderação: admin apaga comentários de posts do grupo
  if not exists (select 1 from pg_policies where tablename = 'comments' and policyname = 'admin modera') then
    create policy "admin modera" on comments for delete using (public.is_admin() and public.decision_visible(decision_id));
  end if;

  -- visto por: o grupo vê quem viu; cada um registra a própria visita
  if not exists (select 1 from pg_policies where tablename = 'post_views' and policyname = 'grupo vê') then
    create policy "grupo vê" on post_views for select using (public.decision_visible(decision_id) or public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'post_views' and policyname = 'registrar a minha') then
    create policy "registrar a minha" on post_views for insert with check (user_id = auth.uid() and public.decision_visible(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'post_views' and policyname = 'atualizar a minha') then
    create policy "atualizar a minha" on post_views for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;

  -- prints de posts (mesa, lobby e prints dos comentários) para o grupo
  if not exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'prints do swap') then
    create policy "prints do swap" on storage.objects for select to authenticated
      using (bucket_id = 'hands' and public.forum_allows(name));
  end if;
end $$;

-- quem não é o autor do comentário só pode mudar o "fixado"
create or replace function public.comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.user_id is distinct from auth.uid() then
    if new.body is distinct from old.body or new.images is distinct from old.images
       or new.user_id is distinct from old.user_id or new.decision_id is distinct from old.decision_id then
      raise exception 'só quem escreveu pode editar o comentário';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists comments_guard on comments;
create trigger comments_guard before update on comments for each row execute function public.comments_guard();
