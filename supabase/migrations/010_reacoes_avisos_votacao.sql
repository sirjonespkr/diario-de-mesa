-- Fórum do swap, partes 2 e 3: reações, avisos (comentário, menção, reação), votação às cegas e spoiler.
-- Pode rodar mais de uma vez sem problema.

-- ---------- reações ----------
create table if not exists reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  decision_id uuid not null references decisions on delete cascade,
  comment_id uuid references comments on delete cascade,
  kind text not null check (kind in ('concordo', 'discordo', 'duvida', 'otima', 'rever')),
  created_at timestamptz not null default now()
);
create unique index if not exists reactions_uniq on reactions (user_id, decision_id, coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);
create index if not exists reactions_decision on reactions (decision_id);

-- ---------- avisos ----------
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  actor_id uuid references auth.users on delete set null,
  kind text not null,
  decision_id uuid references decisions on delete cascade,
  comment_id uuid references comments on delete cascade,
  detail text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user on notifications (user_id, read, created_at desc);

-- ---------- votação às cegas ----------
create table if not exists polls (
  decision_id uuid primary key references decisions on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  options text[] not null check (array_length(options, 1) between 2 and 6),
  revealed boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists poll_votes (
  decision_id uuid not null references polls on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  option int not null check (option >= 0 and option < 6),
  created_at timestamptz not null default now(),
  primary key (decision_id, user_id)
);

-- ---------- spoiler: quem já revelou a resposta ----------
alter table post_views add column if not exists revealed boolean not null default false;

-- os votos aparecem para quem já votou, quando o autor revela, ou quando todos (menos o autor) votaram
create or replace function public.poll_open(d uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from polls where decision_id = d and revealed)
      or exists (select 1 from poll_votes where decision_id = d and user_id = auth.uid())
      or (select count(*) from posts p join group_members m on m.group_id = p.group_id
          where p.decision_id = d and m.user_id <> (select user_id from decisions where id = d))
         <= (select count(*) from poll_votes v where v.decision_id = d and v.user_id <> (select user_id from decisions where id = d));
$$;
-- quem já votou (sem mostrar em quê)
create or replace function public.poll_voters(ids uuid[]) returns table (decision_id uuid, user_id uuid)
language sql stable security definer set search_path = public as $$
  select v.decision_id, v.user_id from poll_votes v
  where v.decision_id = any(ids) and (public.decision_visible(v.decision_id) or public.decision_owner(v.decision_id));
$$;
grant execute on function public.poll_open(uuid), public.poll_voters(uuid[]) to authenticated;

alter table reactions enable row level security;
alter table notifications enable row level security;
alter table polls enable row level security;
alter table poll_votes enable row level security;
do $$
begin
  -- reações: o grupo vê e reage em posts; cada um tira a própria
  if not exists (select 1 from pg_policies where tablename = 'reactions' and policyname = 'grupo vê') then
    create policy "grupo vê" on reactions for select using (public.decision_visible(decision_id) or public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'reactions' and policyname = 'reagir') then
    create policy "reagir" on reactions for insert with check (user_id = auth.uid() and public.decision_visible(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'reactions' and policyname = 'tirar a minha') then
    create policy "tirar a minha" on reactions for delete using (user_id = auth.uid());
  end if;
  -- avisos: cada um só vê e mexe nos seus (quem cria são os gatilhos abaixo)
  if not exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'meus avisos') then
    create policy "meus avisos" on notifications for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'marcar lido') then
    create policy "marcar lido" on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'apagar os meus') then
    create policy "apagar os meus" on notifications for delete using (user_id = auth.uid());
  end if;
  -- votação: o grupo vê a enquete; só o autor da dúvida cria, revela ou apaga
  if not exists (select 1 from pg_policies where tablename = 'polls' and policyname = 'grupo vê') then
    create policy "grupo vê" on polls for select using (public.decision_visible(decision_id) or public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'polls' and policyname = 'autor cria') then
    create policy "autor cria" on polls for insert with check (user_id = auth.uid() and public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'polls' and policyname = 'autor altera') then
    create policy "autor altera" on polls for update using (public.decision_owner(decision_id)) with check (public.decision_owner(decision_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'polls' and policyname = 'autor apaga') then
    create policy "autor apaga" on polls for delete using (public.decision_owner(decision_id));
  end if;
  -- votos: cada um vota uma vez; os votos dos outros só aparecem quando a votação abre para você
  if not exists (select 1 from pg_policies where tablename = 'poll_votes' and policyname = 'ver votos') then
    create policy "ver votos" on poll_votes for select using (
      user_id = auth.uid() or ((public.decision_visible(decision_id) or public.decision_owner(decision_id)) and public.poll_open(decision_id)));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'poll_votes' and policyname = 'votar') then
    create policy "votar" on poll_votes for insert with check (user_id = auth.uid() and public.decision_visible(decision_id));
  end if;
end $$;

-- ---------- gatilhos que criam os avisos ----------
-- (post novo não vira aviso: o selo do fórum já mostra os não vistos)
drop trigger if exists notify_post on posts;
drop function if exists public.notify_post();

create or replace function public.notify_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_group uuid;
begin
  select p.group_id into v_group from posts p where p.decision_id = new.decision_id;
  if v_group is null then return new; end if; -- dúvida não postada: anotação privada, sem aviso
  select d.user_id into v_owner from decisions d where d.id = new.decision_id;
  -- quem foi marcado com @nick
  insert into notifications (user_id, actor_id, kind, decision_id, comment_id)
  select pr.user_id, new.user_id, 'mention', new.decision_id, new.id
  from group_members m join profiles pr on pr.user_id = m.user_id
  where m.group_id = v_group and m.user_id <> new.user_id
    and coalesce(pr.nick, '') <> '' and position(lower('@' || pr.nick) in lower(coalesce(new.body, ''))) > 0;
  -- o autor do post
  insert into notifications (user_id, actor_id, kind, decision_id, comment_id)
  select v_owner, new.user_id, 'comment', new.decision_id, new.id
  where v_owner <> new.user_id
    and not exists (select 1 from notifications n where n.comment_id = new.id and n.user_id = v_owner);
  -- quem já participou da discussão
  insert into notifications (user_id, actor_id, kind, decision_id, comment_id)
  select distinct c.user_id, new.user_id, 'reply', new.decision_id, new.id
  from comments c join group_members m on m.user_id = c.user_id and m.group_id = v_group
  where c.decision_id = new.decision_id and c.id <> new.id and c.user_id <> new.user_id and c.user_id <> v_owner
    and not exists (select 1 from notifications n where n.comment_id = new.id and n.user_id = c.user_id);
  return new;
end $$;
drop trigger if exists notify_comment on comments;
create trigger notify_comment after insert on comments for each row execute function public.notify_comment();

create or replace function public.notify_reaction() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_target uuid;
begin
  if not exists (select 1 from posts where decision_id = new.decision_id) then return new; end if;
  if new.comment_id is not null then
    select user_id into v_target from comments where id = new.comment_id;
  else
    select user_id into v_target from decisions where id = new.decision_id;
  end if;
  if v_target is not null and v_target <> new.user_id then
    insert into notifications (user_id, actor_id, kind, decision_id, comment_id, detail)
    values (v_target, new.user_id, 'reaction', new.decision_id, new.comment_id, new.kind);
  end if;
  return new;
end $$;
drop trigger if exists notify_reaction on reactions;
create trigger notify_reaction after insert on reactions for each row execute function public.notify_reaction();
