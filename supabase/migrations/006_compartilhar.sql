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
