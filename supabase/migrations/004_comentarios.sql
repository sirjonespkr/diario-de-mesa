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
