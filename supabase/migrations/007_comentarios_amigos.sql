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
