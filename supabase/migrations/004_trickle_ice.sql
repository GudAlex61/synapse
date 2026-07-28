-- Reliable WebRTC candidate exchange for mobile and mixed-network peers.
-- Apply after 003_p2p_streaming.sql.

alter table public.watch_room_signals
  drop constraint if exists watch_room_signals_kind_check;

alter table public.watch_room_signals
  add constraint watch_room_signals_kind_check
  check (kind in ('viewer-ready', 'offer', 'answer', 'ice-candidate', 'bye'));

create or replace function public.push_watch_room_signal(
  p_room_id text,
  p_sender_id text,
  p_recipient_id text,
  p_session_id text,
  p_kind text,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if p_room_id is null or p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then raise exception 'Invalid room code'; end if;
  if char_length(coalesce(p_sender_id, '')) not between 1 and 100 then raise exception 'Invalid sender'; end if;
  if char_length(coalesce(p_recipient_id, '')) not between 1 and 100 then raise exception 'Invalid recipient'; end if;
  if char_length(coalesce(p_session_id, '')) not between 1 and 100 then raise exception 'Invalid session'; end if;
  if p_kind not in ('viewer-ready', 'offer', 'answer', 'ice-candidate', 'bye') then raise exception 'Invalid signal kind'; end if;
  if octet_length(coalesce(p_payload, '{}'::jsonb)::text) > 500000 then raise exception 'Signal is too large'; end if;

  delete from public.watch_room_signals where created_at < now() - interval '10 minutes';

  insert into public.watch_room_signals (
    room_id, sender_id, recipient_id, session_id, kind, payload
  ) values (
    p_room_id, left(p_sender_id, 100), left(p_recipient_id, 100),
    left(p_session_id, 100), p_kind, coalesce(p_payload, '{}'::jsonb)
  ) returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.push_watch_room_signal(text, text, text, text, text, jsonb) from public;
grant execute on function public.push_watch_room_signal(text, text, text, text, text, jsonb) to anon, authenticated;
