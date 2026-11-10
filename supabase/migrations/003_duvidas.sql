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
