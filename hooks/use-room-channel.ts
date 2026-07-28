"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { getClientId } from "@/lib/room"
import type {
  ChatEvent,
  LogicalRevision,
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
  onPlayer?: (event: PlayerEvent) => void
  onChat?: (event: ChatEvent) => void
  onSource?: (event: SourceInfo) => void
  onStateRequest?: (fromId: string) => void
  onStateResponse?: (event: StateResponse) => void
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
const COMPACT_EVENTS = new Set(["player", "source", "state-response", "state-request"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRevision(value: unknown): value is LogicalRevision {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.counter) &&
    Number(value.counter) >= 0 &&
    typeof value.senderId === "string" &&
    value.senderId.length <= 100
  )
}

function isPlayerEvent(value: unknown): value is PlayerEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["play", "pause", "seek"].includes(String(value.action)) &&
    isFiniteNumber(value.videoTime) &&
    value.videoTime >= 0 &&
    typeof value.playing === "boolean" &&
    typeof value.sourceId === "string" &&
    value.sourceId.length <= 200 &&
    isRevision(value.revision) &&
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
  if (!["url", "p2p"].includes(String(value.kind))) return false
  if (
    typeof value.sourceId !== "string" ||
    value.sourceId.length === 0 ||
    value.sourceId.length > 200 ||
    typeof value.label !== "string" ||
    !isRevision(value.revision) ||
    typeof value.senderId !== "string"
  ) {
    return false
  }
  if (value.duration !== null && !isFiniteNumber(value.duration)) return false
  if (value.fileSize !== undefined && (!isFiniteNumber(value.fileSize) || value.fileSize < 0)) return false
  if (value.kind === "p2p") {
    return (
      typeof value.ownerId === "string" &&
      value.ownerId.length > 0 &&
      value.ownerId.length <= 100 &&
      typeof value.streamSessionId === "string" &&
      value.streamSessionId.length > 0 &&
      value.streamSessionId.length <= 100
    )
  }
  if (value.kind === "url") {
    if (typeof value.url !== "string" || value.url.length > 4000) return false
    try {
      const url = new URL(value.url)
      return url.protocol === "http:" || url.protocol === "https:"
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
    value.videoTime >= 0 &&
    typeof value.playing === "boolean" &&
    isRevision(value.revision) &&
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
  const flushingRef = useRef(false)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])

  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const userNameRef = useRef(userName)
  userNameRef.current = userName

  const queueBroadcast = useCallback((event: string, payload: unknown) => {
    if (COMPACT_EVENTS.has(event)) {
      queueRef.current = queueRef.current.filter((item) => item.event !== event)
    }
    queueRef.current = [...queueRef.current.slice(-(MAX_QUEUE - 1)), { event, payload }]
  }, [])

  const deliver = useCallback(async (event: string, payload: unknown): Promise<boolean> => {
    const channel = channelRef.current
    if (!channel) return false

    if (readyRef.current) {
      try {
        const result = await channel.send({ type: "broadcast", event, payload })
        if (result === "ok") return true
      } catch {
        // Fall back to Broadcast over HTTP below.
      }
    }

    try {
      const result = await channel.httpSend(event, payload)
      return result.success
    } catch {
      return false
    }
  }, [])

  const flushQueue = useCallback(async () => {
    if (flushingRef.current || !channelRef.current) return
    flushingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0]
        if (!(await deliver(next.event, next.payload))) break
        queueRef.current.shift()
      }
    } finally {
      flushingRef.current = false
    }
  }, [deliver])

  const sendNow = useCallback(
    async (event: string, payload: unknown) => {
      if (await deliver(event, payload)) return
      queueBroadcast(event, payload)
      setStatus((current) => (current === "full" ? current : "reconnecting"))
    },
    [deliver, queueBroadcast],
  )

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
    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        broadcast: { self: false, ack: false },
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
        const meta = state[key]?.at(-1)
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

    const ignoreOwnPayload = (payload: unknown) => isRecord(payload) && payload.senderId === id

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
        if (key !== id) handlersRef.current.onSystem?.("Partner disconnected — commands will keep syncing through the database.")
      })
      .on("broadcast", { event: "player" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isPlayerEvent(payload)) handlersRef.current.onPlayer?.(payload)
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isChatEvent(payload)) handlersRef.current.onChat?.(payload)
      })
      .on("broadcast", { event: "source" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isSourceInfo(payload)) handlersRef.current.onSource?.(payload)
      })
      .on("broadcast", { event: "state-request" }, ({ payload }) => {
        if (!isRecord(payload) || typeof payload.fromId !== "string" || payload.fromId === id) return
        handlersRef.current.onStateRequest?.(payload.fromId)
      })
      .on("broadcast", { event: "state-response" }, ({ payload }) => {
        if (!ignoreOwnPayload(payload) && isStateResponse(payload)) handlersRef.current.onStateResponse?.(payload)
      })
      .subscribe(async (channelStatus, error) => {
        if (channelStatus === "SUBSCRIBED") {
          readyRef.current = true
          await channel.track({ id, name: userNameRef.current, onlineAt: joinedAt.current })
          setConnectionError(null)
          setStatus((current) => (current === "full" ? current : "connected"))
          await flushQueue()
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

    const onOnline = () => {
      supabase.realtime.connect()
      void flushQueue()
    }
    window.addEventListener("online", onOnline)

    return () => {
      window.removeEventListener("online", onOnline)
      readyRef.current = false
      void channel.untrack()
      void supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [flushQueue, roomId, sendNow])

  const sendPlayer = useCallback(
    (event: Omit<PlayerEvent, "senderId" | "at" | "id">) => {
      const payload: PlayerEvent = {
        ...event,
        id: crypto.randomUUID(),
        senderId: myId.current,
        at: Date.now(),
      }
      void sendNow("player", payload)
      return payload
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
      const payload: StateResponse = {
        ...state,
        senderId: myId.current,
        at: Date.now(),
      }
      void sendNow("state-response", payload)
      return payload
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
