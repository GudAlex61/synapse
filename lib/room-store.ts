"use client"

import { createClient } from "@/lib/supabase/client"
import {
  dedupeMessages,
  mergeSnapshots,
  parseRoomSnapshot,
} from "@/lib/room-snapshot"
import type { ChatEvent, PersistedRoomState, RoomSnapshot } from "@/lib/sync-types"

const CACHE_PREFIX = "watch-together:room-cache:"
const MAX_MESSAGES = 500

export { dedupeMessages, mergeSnapshots, parseRoomSnapshot }

function cacheKey(roomId: string) {
  return `${CACHE_PREFIX}${roomId}`
}

export function loadCachedSnapshot(roomId: string): RoomSnapshot {
  if (typeof window === "undefined") return { state: null, messages: [] }
  try {
    const raw = window.localStorage.getItem(cacheKey(roomId))
    return raw ? parseRoomSnapshot(JSON.parse(raw)) : { state: null, messages: [] }
  } catch {
    return { state: null, messages: [] }
  }
}

export function saveCachedSnapshot(roomId: string, snapshot: RoomSnapshot): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      cacheKey(roomId),
      JSON.stringify({
        state: snapshot.state,
        messages: dedupeMessages(snapshot.messages).slice(-MAX_MESSAGES),
      }),
    )
  } catch {
    // Storage may be disabled or full. Remote persistence still remains available.
  }
}

export async function loadRemoteSnapshot(roomId: string): Promise<RoomSnapshot> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc("get_watch_room_snapshot", {
    p_room_id: roomId,
  })
  if (error) throw new Error(error.message)
  return parseRoomSnapshot(data)
}

export async function persistRoomMessage(roomId: string, message: ChatEvent): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.rpc("save_watch_room_message", {
    p_room_id: roomId,
    p_id: message.id,
    p_sender_id: message.senderId,
    p_sender_name: message.senderName,
    p_text: message.text,
    p_client_sent_at: message.at,
  })
  if (error) throw new Error(error.message)
}

export async function persistRoomState(
  roomId: string,
  state: PersistedRoomState,
): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.rpc("save_watch_room_state", {
    p_room_id: roomId,
    p_source: state.source,
    p_video_time: state.videoTime,
    p_playing: state.playing,
    p_updated_by: state.updatedBy,
    p_client_updated_at: state.updatedAt,
  })
  if (error) throw new Error(error.message)
}

export async function removeStoredVideo(storagePath: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.storage.from("room-videos").remove([storagePath])
  if (error) throw new Error(error.message)
}
