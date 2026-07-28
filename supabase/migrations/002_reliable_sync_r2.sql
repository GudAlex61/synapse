-- Reliable playback revisions, room membership, and automatic database cleanup.
-- Apply after 001_watch_rooms.sql. Video files are no longer stored in Supabase Storage.

alter table public.watch_room_states
  add column if not exists revision_counter bigint not null default 0,
  add column if not exists revision_sender text not null default '';

create table if not exists public.watch_room_members (
  room_id text not null,
  member_id text not null,
  last_seen timestamptz not null default now(),
  primary key (room_id, member_id),
  constraint watch_room_members_room_id_check
    check (room_id ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint watch_room_members_member_id_check
    check (char_length(member_id) between 1 and 100)
);

create index if not exists watch_room_members_seen_idx
  on public.watch_room_members (last_seen);

alter table public.watch_room_members enable row level security;
revoke all on table public.watch_room_members from anon, authenticated;

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
    'revision', jsonb_build_object(
      'counter', revision_counter,
      'senderId', revision_sender
    ),
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

-- Remove the previous six-argument overload so accidental old clients cannot
-- overwrite a newer revision without revision metadata.
drop function if exists public.save_watch_room_state(
  text, jsonb, double precision, boolean, text, bigint
);

create or replace function public.save_watch_room_state(
  p_room_id text,
  p_source jsonb,
  p_video_time double precision,
  p_playing boolean,
  p_updated_by text,
  p_client_updated_at bigint,
  p_revision_counter bigint,
  p_revision_sender text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_existing_counter bigint;
  v_existing_sender text;
  v_existing_updated_at bigint;
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid room code';
  end if;
  if p_updated_by is null or char_length(p_updated_by) > 100 then
    raise exception 'Invalid participant id';
  end if;
  if p_revision_counter is null or p_revision_counter < 0 then
    raise exception 'Invalid revision counter';
  end if;
  if p_revision_sender is null or char_length(p_revision_sender) > 100 then
    raise exception 'Invalid revision sender';
  end if;

  if p_source is not null then
    v_kind := p_source ->> 'kind';
    if v_kind not in ('url', 'r2') then
      raise exception 'Invalid persisted source kind';
    end if;
    if char_length(coalesce(p_source ->> 'sourceId', '')) not between 1 and 200 then
      raise exception 'Invalid source id';
    end if;
    if char_length(coalesce(p_source ->> 'label', '')) > 500 then
      raise exception 'Source label is too long';
    end if;
    if v_kind = 'url' and char_length(coalesce(p_source ->> 'url', '')) not between 1 and 4000 then
      raise exception 'Invalid source URL';
    end if;
    if v_kind = 'r2' and (
      char_length(coalesce(p_source ->> 'objectKey', '')) not between 1 and 1024
      or (p_source ->> 'objectKey') not like ('rooms/' || p_room_id || '/%')
    ) then
      raise exception 'Invalid R2 object key';
    end if;
  end if;

  select revision_counter, revision_sender, client_updated_at
  into v_existing_counter, v_existing_sender, v_existing_updated_at
  from public.watch_room_states
  where room_id = p_room_id
  for update;

  if found and (
    p_revision_counter < v_existing_counter
    or (
      p_revision_counter = v_existing_counter
      and p_revision_sender < v_existing_sender
    )
    or (
      p_revision_counter = v_existing_counter
      and p_revision_sender = v_existing_sender
      and p_client_updated_at < v_existing_updated_at
    )
  ) then
    return;
  end if;

  insert into public.watch_room_states (
    room_id,
    source,
    video_time,
    playing,
    updated_by,
    client_updated_at,
    revision_counter,
    revision_sender,
    updated_at
  ) values (
    p_room_id,
    p_source,
    greatest(coalesce(p_video_time, 0), 0),
    coalesce(p_playing, false),
    left(p_updated_by, 100),
    greatest(coalesce(p_client_updated_at, 0), 0),
    p_revision_counter,
    left(p_revision_sender, 100),
    now()
  )
  on conflict (room_id) do update set
    source = excluded.source,
    video_time = excluded.video_time,
    playing = excluded.playing,
    updated_by = excluded.updated_by,
    client_updated_at = excluded.client_updated_at,
    revision_counter = excluded.revision_counter,
    revision_sender = excluded.revision_sender,
    updated_at = now()
  where
    excluded.revision_counter > watch_room_states.revision_counter
    or (
      excluded.revision_counter = watch_room_states.revision_counter
      and excluded.revision_sender > watch_room_states.revision_sender
    )
    or (
      excluded.revision_counter = watch_room_states.revision_counter
      and excluded.revision_sender = watch_room_states.revision_sender
      and excluded.client_updated_at >= watch_room_states.client_updated_at
    );
end;
$$;

create or replace function public.touch_watch_room_member(
  p_room_id text,
  p_member_id text
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
  if p_member_id is null or char_length(p_member_id) not between 1 and 100 then
    raise exception 'Invalid participant id';
  end if;

  delete from public.watch_room_members
  where last_seen < now() - interval '5 minutes';

  insert into public.watch_room_members (room_id, member_id, last_seen)
  values (p_room_id, left(p_member_id, 100), now())
  on conflict (room_id, member_id) do update set last_seen = excluded.last_seen;
end;
$$;

create or replace function public.leave_watch_room(
  p_room_id text,
  p_member_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_count integer;
  v_object_key text;
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid room code';
  end if;
  if p_member_id is null or char_length(p_member_id) not between 1 and 100 then
    raise exception 'Invalid participant id';
  end if;

  delete from public.watch_room_members
  where room_id = p_room_id and member_id = p_member_id;

  delete from public.watch_room_members
  where last_seen < now() - interval '5 minutes';

  select count(*) into v_active_count
  from public.watch_room_members
  where room_id = p_room_id;

  if v_active_count > 0 then
    return jsonb_build_object('roomCleared', false);
  end if;

  select source ->> 'objectKey'
  into v_object_key
  from public.watch_room_states
  where room_id = p_room_id and source ->> 'kind' = 'r2';

  delete from public.watch_room_messages where room_id = p_room_id;
  delete from public.watch_room_states where room_id = p_room_id;
  delete from public.watch_room_members where room_id = p_room_id;

  return jsonb_build_object(
    'roomCleared', true,
    'objectKey', v_object_key
  );
end;
$$;

create or replace function public.cleanup_empty_watch_rooms()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted_states integer := 0;
  v_deleted_messages integer := 0;
begin
  delete from public.watch_room_members
  where last_seen < now() - interval '5 minutes';

  delete from public.watch_room_messages message
  where message.created_at < now() - interval '10 minutes'
    and not exists (
      select 1 from public.watch_room_members member
      where member.room_id = message.room_id
    );
  get diagnostics v_deleted_messages = row_count;

  delete from public.watch_room_states state
  where state.updated_at < now() - interval '10 minutes'
    and not exists (
      select 1 from public.watch_room_members member
      where member.room_id = state.room_id
    );
  get diagnostics v_deleted_states = row_count;

  return v_deleted_states + v_deleted_messages;
end;
$$;

revoke all on function public.get_watch_room_snapshot(text) from public;
revoke all on function public.save_watch_room_state(
  text, jsonb, double precision, boolean, text, bigint, bigint, text
) from public;
revoke all on function public.touch_watch_room_member(text, text) from public;
revoke all on function public.leave_watch_room(text, text) from public;
revoke all on function public.cleanup_empty_watch_rooms() from public;

grant execute on function public.get_watch_room_snapshot(text) to anon, authenticated;
grant execute on function public.save_watch_room_state(
  text, jsonb, double precision, boolean, text, bigint, bigint, text
) to anon, authenticated;
grant execute on function public.touch_watch_room_member(text, text) to anon, authenticated;
grant execute on function public.leave_watch_room(text, text) to anon, authenticated;

-- Best-effort automatic cleanup. If Supabase Cron is not enabled, the migration
-- still succeeds; enable Cron in Dashboard and run the schedule block manually.
do $$
begin
  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'pg_cron is not enabled; automatic cleanup must be enabled in Supabase Integrations > Cron.';
  end;

  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin
      execute $unschedule$
        select cron.unschedule('watch-room-empty-cleanup')
      $unschedule$;
    exception when others then
      null;
    end;
    execute $schedule$
      select cron.schedule(
        'watch-room-empty-cleanup',
        '*/5 * * * *',
        'select public.cleanup_empty_watch_rooms();'
      )
    $schedule$;
  end if;
end;
$$;
