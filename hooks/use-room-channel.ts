"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { getClientId } from "@/lib/room"
import type {
  ChatEvent,
  Peer,
  PlayerEvent,
  SourceInfo,
  StateResponse,
} from "@/lib/sync-types"

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "full"
  | "error"

interface Handlers {
  onPlayer?: (e: PlayerEvent) => void
  onChat?: (e: ChatEvent) => void
  onSource?: (e: SourceInfo) => void
  onStateRequest?: (fromId: string) => void
  onStateResponse?: (e: StateResponse) => void
  onSystem?: (text: string) => void
}

interface Options {
  roomId: string
  userName: string
  handlers: Handlers
}

interface QueuedBroadcast {
  event: string
  payload: unknown
}

const MAX_PEERS = 2
const MAX_QUEUE = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isPlayerEvent(value: unknown): value is PlayerEvent {
  return (
    isRecord(value) &&
    ["play", "pause", "seek", "buffer", "resume"].includes(String(value.action)) &&
    isFiniteNumber(value.videoTime) &&
    isFiniteNumber(value.at) &&
    typeof value.senderId === "string"
  )
}

function isChatEvent(value: unknown): value is ChatEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.senderId === "string" &&
    typeof value.senderName === "string" &&
    typeof value.text === "string" &&
    value.text.length <= 500 &&
    isFiniteNumber(value.at)
  )
}

function isSourceInfo(value: unknown): value is SourceInfo {
  if (!isRecord(value)) return false
  if (!["url", "storage", "uploading"].includes(String(value.kind))) return false
  if (typeof value.label !== "string" || typeof value.senderId !== "string") return false
  if (value.duration !== null && !isFiniteNumber(value.duration)) return false
  if (value.kind === "url" || value.kind === "storage") {
    if (typeof value.url !== "string" || value.url.length > 4000) return false
    try {
      const url = new URL(value.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") return false
    } catch {
      return false
    }
  }
  return true
}

function isStateResponse(value: unknown): value is StateResponse {
  return (
    isRecord(value) &&
    (value.source === null || isSourceInfo(value.source)) &&
    isFiniteNumber(value.videoTime) &&
    typeof value.playing === "boolean" &&
    isFiniteNumber(value.at) &&
    typeof value.senderId === "string" &&
    ["join", "heartbeat", "source"].includes(String(value.reason)) &&
    (value.toId === undefined || typeof value.toId === "string")
  )
}

export function useRoomChannel({ roomId, userName, handlers }: Options) {
  const myId = useRef<string>(getClientId())
  const joinedAt = useRef(Date.now())
  const channelRef = useRef<RealtimeChannel | null>(null)
  const readyRef = useRef(false)
  const queueRef = useRef<QueuedBroadcast[]>([])
  const retryTimerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])

  // Keep the latest handlers in a ref so the channel effect doesn't re-run.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const userNameRef = useRef(userName)
  userNameRef.current = userName

  const sendNow = useCallback(async (event: string, payload: unknown) => {
    const queue = () => {
      queueRef.current = [...queueRef.current.slice(-(MAX_QUEUE - 1)), { event, payload }]
    }
    const channel = channelRef.current
    if (!channel || !readyRef.current) {
      queue()
      return
    }

    try {
      const result = await channel.send({ type: "broadcast", event, payload })
      if (result === "ok") return
      queue()
    } catch {
      queue()
    }

    setStatus((current) => (current === "full" ? current : "reconnecting"))
    if (retryTimerRef.current === null) {
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        const next = queueRef.current.shift()
        if (next) void sendNow(next.event, next.payload)
      }, 1000)
    }
  }, [])

  useEffect(() => {
    if (!roomId) return

    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Supabase is not configured.")
      setStatus("error")
      return
    }

    const id = myId.current
    joinedAt.current = Date.now()
    queueRef.current = []
    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        broadcast: { self: false, ack: true },
        presence: { key: id },
      },
    })
    channelRef.current = channel
    readyRef.current = false
    setConnectionError(null)
    setStatus("connecting")

    const computePeers = () => {
      const state = channel.presenceState<{ id: string; name: string; onlineAt: number }>()
      const flat: Peer[] = []

      for (const key of Object.keys(state)) {
        const metas = state[key]
        const meta = metas.at(-1)
        if (!meta || typeof meta.id !== "string") continue
        flat.push({
          id: meta.id,
          name: typeof meta.name === "string" ? meta.name : "Partner",
          onlineAt: typeof meta.onlineAt === "number" ? meta.onlineAt : Date.now(),
        })
      }

      flat.sort((a, b) => a.onlineAt - b.onlineAt || a.id.localeCompare(b.id))
      return flat
    }

    const ignoreOwnPayload = (payload: unknown) =>
      isRecord(payload) && payload.senderId === id

    channel
      .on("presence", { event: "sync" }, () => {
        const flat = computePeers()
        setPeers(flat)

        const allowed = flat.slice(0, MAX_PEERS)
        const amAllowed = allowed.some((peer) => peer.id === id)
        if (!amAllowed && flat.length > MAX_PEERS) {
          readyRef.current = false
          setStatus("full")
          void channel.untrack()
        } else {
          setStatus((current) => (current === "full" ? current : "connected"))
        }
      })
      .on("presence", { event: "join" }, ({ key }) => {
        if (key === id) return
        const joiner = computePeers().find((peer) => peer.id === key)
        if (joiner) handlersRef.current.onSystem?.(`${joiner.name} joined`)
      })
      .on("presence", { event: "leave" }, ({ key }) => {
        if (key !== id) {
          handlersRef.current.onSystem?.("Partner disconnected — waiting to reconnect…")
        }
      })
      .on("broadcast", { event: "player" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isPlayerEvent(payload)) {
          handlersRef.current.onPlayer?.(payload)
        }
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isChatEvent(payload)) {
          handlersRef.current.onChat?.(payload)
        }
      })
      .on("broadcast", { event: "source" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isSourceInfo(payload)) {
          handlersRef.current.onSource?.(payload)
        }
      })
      .on("broadcast", { event: "state-request" }, ({ payload }) => {
        if (!isRecord(payload) || typeof payload.fromId !== "string" || payload.fromId === id) return
        handlersRef.current.onStateRequest?.(payload.fromId)
      })
      .on("broadcast", { event: "state-response" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isStateResponse(payload)) {
          handlersRef.current.onStateResponse?.(payload)
        }
      })
      .subscribe(async (channelStatus, error) => {
        if (channelStatus === "SUBSCRIBED") {
          readyRef.current = true
          await channel.track({
            id,
            name: userNameRef.current,
            onlineAt: joinedAt.current,
          })
          setStatus((current) => (current === "full" ? current : "connected"))

          const queued = queueRef.current
          queueRef.current = []
          for (const item of queued) await sendNow(item.event, item.payload)

          await sendNow("state-request", { fromId: id })
        } else if (
          channelStatus === "CHANNEL_ERROR" ||
          channelStatus === "TIMED_OUT" ||
          channelStatus === "CLOSED"
        ) {
          readyRef.current = false
          if (error) setConnectionError(error.message)
          setStatus((current) => (current === "full" ? current : "reconnecting"))
        }
      })

    return () => {
      readyRef.current = false
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      void channel.untrack()
      void supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [roomId, sendNow])

  const sendPlayer = useCallback(
    (event: Omit<PlayerEvent, "senderId" | "at">) => {
      void sendNow("player", {
        ...event,
        senderId: myId.current,
        at: Date.now(),
      } satisfies PlayerEvent)
    },
    [sendNow],
  )

  const sendChat = useCallback(
    (text: string) => {
      const payload: ChatEvent = {
        id: crypto.randomUUID(),
        senderId: myId.current,
        senderName: userNameRef.current,
        text,
        at: Date.now(),
      }
      void sendNow("chat", payload)
      return payload
    },
    [sendNow],
  )

  const sendSource = useCallback(
    (info: Omit<SourceInfo, "senderId">) => {
      const payload = { ...info, senderId: myId.current } satisfies SourceInfo
      void sendNow("source", payload)
      return payload
    },
    [sendNow],
  )

  const sendState = useCallback(
    (state: Omit<StateResponse, "senderId" | "at">) => {
      void sendNow("state-response", {
        ...state,
        senderId: myId.current,
        at: Date.now(),
      } satisfies StateResponse)
    },
    [sendNow],
  )

  const partner = useMemo(
    () => peers.find((peer) => peer.id !== myId.current) ?? null,
    [peers],
  )

  return useMemo(
    () => ({
      myId: myId.current,
      status,
      connectionError,
      peers,
      partner,
      sendPlayer,
      sendChat,
      sendSource,
      sendState,
    }),
    [connectionError, partner, peers, sendChat, sendPlayer, sendSource, sendState, status],
  )
}
