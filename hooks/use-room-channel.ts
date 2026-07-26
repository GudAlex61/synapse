"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "full"

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

const MAX_PEERS = 2

export function useRoomChannel({ roomId, userName, handlers }: Options) {
  const myId = useRef<string>(getClientId())
  const channelRef = useRef<RealtimeChannel | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [peers, setPeers] = useState<Peer[]>([])

  // Keep the latest handlers in a ref so the channel effect doesn't re-run
  // (and re-subscribe) every render.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const userNameRef = useRef(userName)
  userNameRef.current = userName

  useEffect(() => {
    if (!roomId) return
    const supabase = createClient()
    const id = myId.current

    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        broadcast: { self: false },
        presence: { key: id },
      },
    })
    channelRef.current = channel

    const computePeers = () => {
      const state = channel.presenceState<{ id: string; name: string; onlineAt: number }>()
      const flat: Peer[] = []
      for (const key of Object.keys(state)) {
        const metas = state[key]
        if (metas.length > 0) {
          const m = metas[0]
          flat.push({ id: m.id, name: m.name, onlineAt: m.onlineAt })
        }
      }
      // Deterministic ordering: earliest joiner first. If more than MAX_PEERS
      // are present, the later joiners are the "overflow".
      flat.sort((a, b) => a.onlineAt - b.onlineAt)
      return flat
    }

    channel
      .on("presence", { event: "sync" }, () => {
        const flat = computePeers()
        setPeers(flat)

        const allowed = flat.slice(0, MAX_PEERS)
        const amAllowed = allowed.some((p) => p.id === id)
        if (!amAllowed && flat.length > MAX_PEERS) {
          setStatus("full")
          channel.untrack()
        } else if (status !== "full") {
          setStatus("connected")
        }
      })
      .on("presence", { event: "join" }, ({ key }) => {
        if (key !== id) {
          const flat = computePeers()
          const joiner = flat.find((p) => p.id === key)
          if (joiner) handlersRef.current.onSystem?.(`${joiner.name} joined`)
        }
      })
      .on("presence", { event: "leave" }, ({ key }) => {
        if (key !== id) {
          handlersRef.current.onSystem?.("Partner disconnected — waiting to reconnect…")
        }
      })
      .on("broadcast", { event: "player" }, ({ payload }) => {
        handlersRef.current.onPlayer?.(payload as PlayerEvent)
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        handlersRef.current.onChat?.(payload as ChatEvent)
      })
      .on("broadcast", { event: "source" }, ({ payload }) => {
        handlersRef.current.onSource?.(payload as SourceInfo)
      })
      .on("broadcast", { event: "state-request" }, ({ payload }) => {
        handlersRef.current.onStateRequest?.((payload as { fromId: string }).fromId)
      })
      .on("broadcast", { event: "state-response" }, ({ payload }) => {
        const res = payload as StateResponse
        // Only the requester cares; but broadcast reaches everyone, so the
        // consumer decides whether it still needs the state.
        handlersRef.current.onStateResponse?.(res)
      })
      .subscribe(async (channelStatus) => {
        if (channelStatus === "SUBSCRIBED") {
          await channel.track({ id, name: userNameRef.current, onlineAt: Date.now() })
          setStatus((s) => (s === "full" ? s : "connected"))
          // Ask any existing member for the current playback state.
          channel.send({
            type: "broadcast",
            event: "state-request",
            payload: { fromId: id },
          })
        } else if (channelStatus === "CHANNEL_ERROR" || channelStatus === "TIMED_OUT") {
          setStatus("reconnecting")
        } else if (channelStatus === "CLOSED") {
          setStatus("reconnecting")
        }
      })

    return () => {
      channel.untrack()
      supabase.removeChannel(channel)
      channelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  const send = useCallback((event: string, payload: unknown) => {
    channelRef.current?.send({ type: "broadcast", event, payload })
  }, [])

  const sendPlayer = useCallback(
    (e: Omit<PlayerEvent, "senderId" | "at">) => {
      send("player", { ...e, senderId: myId.current, at: Date.now() } satisfies PlayerEvent)
    },
    [send],
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
      send("chat", payload)
      return payload
    },
    [send],
  )

  const sendSource = useCallback(
    (info: Omit<SourceInfo, "senderId">) => {
      send("source", { ...info, senderId: myId.current } satisfies SourceInfo)
    },
    [send],
  )

  const sendState = useCallback(
    (state: Omit<StateResponse, "senderId" | "at">) => {
      send("state-response", {
        ...state,
        senderId: myId.current,
        at: Date.now(),
      } satisfies StateResponse)
    },
    [send],
  )

  return {
    myId: myId.current,
    status,
    peers,
    partner: peers.find((p) => p.id !== myId.current) ?? null,
    sendPlayer,
    sendChat,
    sendSource,
    sendState,
  }
}
