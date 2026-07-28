-- Persistent watch-room state, chat history and shared video storage.
-- Run this once in Supabase SQL Editor (or through `supabase db push`).

create table if not exists public.watch_room_states (
  room_id text primary key,
  source jsonb,
  video_time double precision not null default 0,
  playing boolean not null default false,
  updated_by text not null default '',
  client_updated_at bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint watch_room_states_room_id_check
    check (room_id ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint watch_room_states_video_time_check
    check (video_time >= 0 and video_time < 1000000000)
);

create table if not exists public.watch_room_messages (
  id uuid primary key,
  room_id text not null,
  sender_id text not null,
  sender_name text not null,
  body text not null,
  client_sent_at bigint not null,
  created_at timestamptz not null default now(),
  constraint watch_room_messages_room_id_check
    check (room_id ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint watch_room_messages_sender_name_check
    check (char_length(sender_name) between 1 and 24),
  constraint watch_room_messages_body_check
    check (char_length(body) between 1 and 500)
);

create index if not exists watch_room_messages_room_time_idx
  on public.watch_room_messages (room_id, client_sent_at desc);

alter table public.watch_room_states enable row level security;
alter table public.watch_room_messages enable row level security;

-- Tables are intentionally not exposed directly. The browser only receives
-- narrowly-scoped SECURITY DEFINER RPC functions requiring an exact room code.
revoke all on table public.watch_room_states from anon, authenticated;
revoke all on table public.watch_room_messages from anon, authenticated;

create or replace function public.get_watch_room_snapshot(p_room_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state jsonb;
  v_messages jsonb;
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid room code';
  end if;

  select jsonb_build_object(
    'source', source,
    'videoTime', video_time,
    'playing', playing,
    'updatedAt', client_updated_at,
    'updatedBy', updated_by
  )
  into v_state
  from public.watch_room_states
  where room_id = p_room_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', message.id,
        'senderId', message.sender_id,
        'senderName', message.sender_name,
        'text', message.body,
        'at', message.client_sent_at
      )
      order by message.client_sent_at, message.id
    ),
    '[]'::jsonb
  )
  into v_messages
  from (
    select id, sender_id, sender_name, body, client_sent_at
    from public.watch_room_messages
    where room_id = p_room_id
    order by client_sent_at desc, id desc
    limit 500
  ) as message;

  return jsonb_build_object('state', v_state, 'messages', v_messages);
end;
$$;

create or replace function public.save_watch_room_message(
  p_room_id text,
  p_id uuid,
  p_sender_id text,
  p_sender_name text,
  p_text text,
  p_client_sent_at bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid room code';
  end if;
  if p_sender_id is null or char_length(p_sender_id) > 100 then
    raise exception 'Invalid sender id';
  end if;
  if p_sender_name is null or char_length(btrim(p_sender_name)) not between 1 and 24 then
    raise exception 'Invalid sender name';
  end if;
  if p_text is null or char_length(btrim(p_text)) not between 1 and 500 then
    raise exception 'Invalid message';
  end if;

  insert into public.watch_room_messages (
    id, room_id, sender_id, sender_name, body, client_sent_at
  ) values (
    p_id,
    p_room_id,
    left(p_sender_id, 100),
    left(btrim(p_sender_name), 24),
    left(btrim(p_text), 500),
    greatest(p_client_sent_at, 0)
  )
  on conflict (id) do nothing;

  -- Keep room history bounded to the latest 500 messages.
  delete from public.watch_room_messages
  where id in (
    select id
    from public.watch_room_messages
    where room_id = p_room_id
    order by client_sent_at desc, id desc
    offset 500
  );
end;
$$;

create or replace function public.save_watch_room_state(
  p_room_id text,
  p_source jsonb,
  p_video_time double precision,
  p_playing boolean,
  p_updated_by text,
  p_client_updated_at bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid room code';
  end if;
  if p_updated_by is null or char_length(p_updated_by) > 100 then
    raise exception 'Invalid participant id';
  end if;
  if p_source is not null then
    v_kind := p_source ->> 'kind';
    if v_kind not in ('url', 'storage') then
      raise exception 'Invalid persisted source kind';
    end if;
    if char_length(coalesce(p_source ->> 'label', '')) > 500 then
      raise exception 'Source label is too long';
    end if;
    if char_length(coalesce(p_source ->> 'url', '')) > 4000 then
      raise exception 'Source URL is too long';
    end if;
  end if;

  insert into public.watch_room_states (
    room_id,
    source,
    video_time,
    playing,
    updated_by,
    client_updated_at,
    updated_at
  ) values (
    p_room_id,
    p_source,
    greatest(coalesce(p_video_time, 0), 0),
    coalesce(p_playing, false),
    left(p_updated_by, 100),
    greatest(coalesce(p_client_updated_at, 0), 0),
    now()
  )
  on conflict (room_id) do update set
    source = excluded.source,
    video_time = excluded.video_time,
    playing = excluded.playing,
    updated_by = excluded.updated_by,
    client_updated_at = excluded.client_updated_at,
    updated_at = now()
  where excluded.client_updated_at >= public.watch_room_states.client_updated_at;
end;
$$;

revoke all on function public.get_watch_room_snapshot(text) from public;
revoke all on function public.save_watch_room_message(text, uuid, text, text, text, bigint) from public;
revoke all on function public.save_watch_room_state(text, jsonb, double precision, boolean, text, bigint) from public;

grant execute on function public.get_watch_room_snapshot(text) to anon, authenticated;
grant execute on function public.save_watch_room_message(text, uuid, text, text, text, bigint) to anon, authenticated;
grant execute on function public.save_watch_room_state(text, jsonb, double precision, boolean, text, bigint) to anon, authenticated;

-- Public playback bucket. Object names contain a random UUID and room folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('room-videos', 'room-videos', true, 5368709120)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

drop policy if exists "watch room video uploads" on storage.objects;
create policy "watch room video uploads"
on storage.objects for insert
to anon, authenticated
with check (
  bucket_id = 'room-videos'
  and (storage.foldername(name))[1] ~ '^[A-HJ-NP-Z2-9]{6}$'
);

drop policy if exists "watch room video reads" on storage.objects;
create policy "watch room video reads"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'room-videos');

drop policy if exists "watch room video cleanup" on storage.objects;
create policy "watch room video cleanup"
on storage.objects for delete
to anon, authenticated
using (
  bucket_id = 'room-videos'
  and (storage.foldername(name))[1] ~ '^[A-HJ-NP-Z2-9]{6}$'
);
