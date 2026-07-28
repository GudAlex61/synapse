"use client"

import { createClient } from "@/lib/supabase/client"
import type { RtcSignal, RtcSignalKind } from "@/lib/sync-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseSignal(value: unknown): RtcSignal | null {
  if (!isRecord(value)) return null
  if (
    !Number.isSafeInteger(value.id) ||
    typeof value.senderId !== "string" ||
    typeof value.recipientId !== "string" ||
    typeof value.sessionId !== "string" ||
    !["viewer-ready", "offer", "answer", "bye"].includes(String(value.kind)) ||
    !isRecord(value.payload)
  ) {
    return null
  }
  return {
    id: Number(value.id),
    senderId: value.senderId,
    recipientId: value.recipientId,
    sessionId: value.sessionId,
    kind: value.kind as RtcSignalKind,
    payload: value.payload,
    at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : Date.now(),
  }
}

export async function pushRtcSignal(input: {
  roomId: string
  senderId: string
  recipientId: string
  sessionId: string
  kind: RtcSignalKind
  payload?: Record<string, unknown>
}): Promise<number> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc("push_watch_room_signal", {
    p_room_id: input.roomId,
    p_sender_id: input.senderId,
    p_recipient_id: input.recipientId,
    p_session_id: input.sessionId,
    p_kind: input.kind,
    p_payload: input.payload ?? {},
  })
  if (error) throw new Error(error.message)
  const id = Number(data)
  if (!Number.isSafeInteger(id)) throw new Error("Supabase returned an invalid signal id.")
  return id
}

export async function pullRtcSignals(input: {
  roomId: string
  recipientId: string
  sessionId: string
  afterId: number
}): Promise<RtcSignal[]> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc("pull_watch_room_signals", {
    p_room_id: input.roomId,
    p_recipient_id: input.recipientId,
    p_session_id: input.sessionId,
    p_after_id: input.afterId,
  })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) return []
  return data.map(parseSignal).filter((signal): signal is RtcSignal => signal !== null)
}
