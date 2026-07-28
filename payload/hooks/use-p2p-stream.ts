"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { pullRtcSignals, pushRtcSignal } from "@/lib/webrtc-signaling"
import {
  isSessionDescriptionPayload,
  parseIceServers,
  readConnectionStats,
  tuneMovieSenders,
  waitForIceGatheringComplete,
} from "@/lib/webrtc-core"
import type { P2PConnectionStatus, P2PStats, SourceInfo } from "@/lib/sync-types"

interface Options {
  roomId: string
  myId: string
  source: SourceInfo | null
  getLocalStream: () => Promise<MediaStream | null>
}

const SIGNAL_POLL_MS = 700
const VIEWER_READY_MS = 3_000
const DISCONNECTED_GRACE_MS = 5_000
const EMPTY_STATS: P2PStats = {
  bitrateKbps: null,
  roundTripMs: null,
  packetsLost: null,
  framesPerSecond: null,
  candidateType: null,
}

export function useP2PStream({ roomId, myId, source, getLocalStream }: Options) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<P2PConnectionStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<P2PStats>(EMPTY_STATS)

  const connectionRef = useRef<RTCPeerConnection | null>(null)
  const activePeerRef = useRef<string | null>(null)
  const lastSignalIdRef = useRef(0)
  const negotiatingRef = useRef(false)
  const disconnectTimerRef = useRef<number | null>(null)
  const getLocalStreamRef = useRef(getLocalStream)
  const previousStatsBytesRef = useRef<number | null>(null)
  const previousStatsAtRef = useRef<number | null>(null)
  const restartHostIceRef = useRef<() => void>(() => undefined)
  getLocalStreamRef.current = getLocalStream

  const p2pSource = source?.kind === "p2p" ? source : null
  const sessionId = p2pSource?.streamSessionId ?? ""
  const ownerId = p2pSource?.ownerId ?? ""
  const isOwner = Boolean(p2pSource && ownerId === myId)

  const closeConnection = useCallback((nextStatus: P2PConnectionStatus = "idle") => {
    if (disconnectTimerRef.current !== null) {
      window.clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
    const connection = connectionRef.current
    connectionRef.current = null
    activePeerRef.current = null
    negotiatingRef.current = false
    if (connection) {
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.oniceconnectionstatechange = null
      connection.close()
    }
    setRemoteStream((current) => {
      current?.getTracks().forEach((track) => track.stop())
      return null
    })
    previousStatsBytesRef.current = null
    previousStatsAtRef.current = null
    setStats(EMPTY_STATS)
    setStatus(nextStatus)
  }, [])

  const resetAfterFailure = useCallback(() => {
    closeConnection(isOwner ? "waiting-viewer" : "waiting-owner")
  }, [closeConnection, isOwner])

  const attachConnectionHandlers = useCallback(
    (connection: RTCPeerConnection) => {
      connection.onconnectionstatechange = () => {
        if (connection !== connectionRef.current) return
        const state = connection.connectionState
        if (state === "connected") {
          if (disconnectTimerRef.current !== null) {
            window.clearTimeout(disconnectTimerRef.current)
            disconnectTimerRef.current = null
          }
          setError(null)
          setStatus("connected")
          return
        }
        if (state === "connecting" || state === "new") {
          setStatus("connecting")
          return
        }
        if (state === "disconnected") {
          setStatus("reconnecting")
          if (disconnectTimerRef.current === null) {
            disconnectTimerRef.current = window.setTimeout(() => {
              if (connection.connectionState === "disconnected") resetAfterFailure()
            }, DISCONNECTED_GRACE_MS)
          }
          return
        }
        if (state === "failed") {
          setError(
            "Прямое P2P-соединение не установилось. Попробуйте другую сеть или отключите VPN; без TURN некоторые NAT не соединяются напрямую.",
          )
          if (isOwner) restartHostIceRef.current()
          else resetAfterFailure()
        }
      }
      connection.oniceconnectionstatechange = () => {
        if (connection !== connectionRef.current || connection.iceConnectionState !== "failed") return
        if (isOwner) restartHostIceRef.current()
        else resetAfterFailure()
      }
    },
    [isOwner, resetAfterFailure],
  )

  const createConnection = useCallback(() => {
    const connection = new RTCPeerConnection({
      iceServers: parseIceServers(process.env.NEXT_PUBLIC_WEBRTC_ICE_SERVERS),
      bundlePolicy: "max-bundle",
      iceCandidatePoolSize: 4,
    })
    connectionRef.current = connection
    attachConnectionHandlers(connection)
    return connection
  }, [attachConnectionHandlers])

  const sendSignal = useCallback(
    async (recipientId: string, kind: "viewer-ready" | "offer" | "answer" | "bye", payload: Record<string, unknown> = {}) => {
      if (!sessionId) return
      await pushRtcSignal({ roomId, senderId: myId, recipientId, sessionId, kind, payload })
    },
    [myId, roomId, sessionId],
  )

  const startHostOffer = useCallback(
    async (viewerId: string) => {
      if (!p2pSource || !isOwner || negotiatingRef.current) return
      const existing = connectionRef.current
      if (
        existing &&
        activePeerRef.current === viewerId &&
        ["new", "connecting", "connected"].includes(existing.connectionState)
      ) return
      closeConnection("connecting")
      negotiatingRef.current = true
      try {
        const stream = await getLocalStreamRef.current()
        if (!stream || stream.getTracks().length === 0) {
          setStatus("waiting-viewer")
          setError("Не удалось захватить видео. Запустите воспроизведение у владельца и попробуйте ещё раз.")
          return
        }
        const connection = createConnection()
        activePeerRef.current = viewerId
        for (const track of stream.getTracks()) connection.addTrack(track, stream)
        await tuneMovieSenders(connection)
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        await waitForIceGatheringComplete(connection)
        const description = connection.localDescription
        if (!description?.sdp) throw new Error("Browser did not create a WebRTC offer.")
        await sendSignal(viewerId, "offer", { type: description.type, sdp: description.sdp })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось начать P2P-трансляцию.")
        resetAfterFailure()
      } finally {
        negotiatingRef.current = false
      }
    },
    [closeConnection, createConnection, isOwner, p2pSource, resetAfterFailure, sendSignal],
  )

  const restartHostIce = useCallback(async () => {
    const connection = connectionRef.current
    const viewerId = activePeerRef.current
    if (negotiatingRef.current) return
    if (!isOwner || !connection || !viewerId) {
      resetAfterFailure()
      return
    }
    negotiatingRef.current = true
    setStatus("reconnecting")
    try {
      connection.restartIce()
      const offer = await connection.createOffer({ iceRestart: true })
      await connection.setLocalDescription(offer)
      await waitForIceGatheringComplete(connection)
      const description = connection.localDescription
      if (!description?.sdp) throw new Error("Browser did not create an ICE-restart offer.")
      await sendSignal(viewerId, "offer", { type: description.type, sdp: description.sdp })
    } catch {
      resetAfterFailure()
    } finally {
      negotiatingRef.current = false
    }
  }, [isOwner, resetAfterFailure, sendSignal])
  restartHostIceRef.current = () => void restartHostIce()

  const acceptOffer = useCallback(
    async (senderId: string, payload: Record<string, unknown>) => {
      if (!p2pSource || isOwner || negotiatingRef.current || !isSessionDescriptionPayload(payload) || payload.type !== "offer") return
      closeConnection("connecting")
      negotiatingRef.current = true
      try {
        const connection = createConnection()
        activePeerRef.current = senderId
        const incoming = new MediaStream()
        connection.ontrack = (event) => {
          const tracks = event.streams[0]?.getTracks() ?? [event.track]
          for (const track of tracks) {
            if (!incoming.getTracks().some((current) => current.id === track.id)) incoming.addTrack(track)
          }
          setRemoteStream(new MediaStream(incoming.getTracks()))
        }
        await connection.setRemoteDescription({ type: payload.type, sdp: payload.sdp })
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        await waitForIceGatheringComplete(connection)
        const description = connection.localDescription
        if (!description?.sdp) throw new Error("Browser did not create a WebRTC answer.")
        await sendSignal(senderId, "answer", { type: description.type, sdp: description.sdp })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось подключиться к трансляции.")
        resetAfterFailure()
      } finally {
        negotiatingRef.current = false
      }
    },
    [closeConnection, createConnection, isOwner, p2pSource, resetAfterFailure, sendSignal],
  )

  const acceptAnswer = useCallback(async (senderId: string, payload: Record<string, unknown>) => {
    const connection = connectionRef.current
    if (!isOwner || !connection || activePeerRef.current !== senderId || !isSessionDescriptionPayload(payload) || payload.type !== "answer") return
    if (connection.signalingState !== "have-local-offer") return
    try {
      await connection.setRemoteDescription({ type: payload.type, sdp: payload.sdp })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось завершить WebRTC-соединение.")
      resetAfterFailure()
    }
  }, [isOwner, resetAfterFailure])

  useEffect(() => {
    lastSignalIdRef.current = 0
    setError(null)
    if (!p2pSource || !sessionId || !ownerId) {
      closeConnection("idle")
      return
    }
    if (!("RTCPeerConnection" in window)) {
      closeConnection("unsupported")
      setError("Этот браузер не поддерживает WebRTC.")
      return
    }
    closeConnection(isOwner ? "waiting-viewer" : "waiting-owner")
  }, [closeConnection, isOwner, ownerId, p2pSource?.sourceId, sessionId])

  useEffect(() => {
    if (!p2pSource || !sessionId || !ownerId) return
    let active = true
    let polling = false

    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const signals = await pullRtcSignals({
          roomId,
          recipientId: myId,
          sessionId,
          afterId: lastSignalIdRef.current,
        })
        for (const signal of signals) {
          lastSignalIdRef.current = Math.max(lastSignalIdRef.current, signal.id)
          if (signal.kind === "viewer-ready" && isOwner) await startHostOffer(signal.senderId)
          else if (signal.kind === "offer" && !isOwner && signal.senderId === ownerId) {
            await acceptOffer(signal.senderId, signal.payload)
          } else if (signal.kind === "answer" && isOwner) {
            await acceptAnswer(signal.senderId, signal.payload)
          } else if (signal.kind === "bye") {
            resetAfterFailure()
          }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? `Сигналинг недоступен: ${reason.message}` : "Сигналинг недоступен.")
      } finally {
        polling = false
      }
    }

    void poll()
    const interval = window.setInterval(() => void poll(), SIGNAL_POLL_MS)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [acceptAnswer, acceptOffer, isOwner, myId, ownerId, p2pSource, resetAfterFailure, roomId, sessionId, startHostOffer])

  useEffect(() => {
    if (!p2pSource || isOwner || !ownerId || !sessionId) return
    const announce = () => {
      if (connectionRef.current?.connectionState === "connected") return
      void sendSignal(ownerId, "viewer-ready").catch(() => undefined)
    }
    announce()
    const interval = window.setInterval(announce, VIEWER_READY_MS)
    return () => window.clearInterval(interval)
  }, [isOwner, ownerId, p2pSource, sendSignal, sessionId])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const connection = connectionRef.current
      if (!connection || connection.connectionState !== "connected") return
      void readConnectionStats(connection, previousStatsBytesRef.current, previousStatsAtRef.current)
        .then((result) => {
          previousStatsBytesRef.current = result.bytes
          previousStatsAtRef.current = result.at
          setStats(result.stats)
        })
        .catch(() => undefined)
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => () => closeConnection("idle"), [closeConnection])

  return { remoteStream, status, error, stats, isOwner }
}
