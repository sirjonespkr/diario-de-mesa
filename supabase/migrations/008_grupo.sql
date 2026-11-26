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
