"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { pullRtcSignals, pushRtcSignal } from "@/lib/webrtc-signaling"
import {
  getIceCandidateType,
  isSessionDescriptionPayload,
  parseIceCandidatePayload,
  parseIceServers,
  readConnectionStats,
  tuneMovieSenders,
} from "@/lib/webrtc-core"
import type { P2PConnectionStatus, P2PStats, RtcSignalKind, SourceInfo } from "@/lib/sync-types"

interface Options {
  roomId: string
  myId: string
  source: SourceInfo | null
  getLocalStream: () => Promise<MediaStream | null>
}

const SIGNAL_POLL_MS = 500
const VIEWER_READY_MS = 3_000
const DISCONNECTED_GRACE_MS = 6_000
const MAX_ICE_RESTARTS = 2
const EMPTY_STATS: P2PStats = {
  bitrateKbps: null,
  roundTripMs: null,
  packetsLost: null,
  framesPerSecond: null,
  candidateType: null,
}

function candidateSummary(types: Set<string>): string {
  return types.size > 0 ? [...types].sort().join(", ") : "нет"
}

export function useP2PStream({ roomId, myId, source, getLocalStream }: Options) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<P2PConnectionStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<P2PStats>(EMPTY_STATS)

  const connectionRef = useRef<RTCPeerConnection | null>(null)
  const activePeerRef = useRef<string | null>(null)
  const currentNegotiationRef = useRef("")
  const lastSignalIdRef = useRef(0)
  const negotiatingRef = useRef(false)
  const localDescriptionSentRef = useRef(false)
  const bufferedLocalCandidatesRef = useRef<Array<RTCIceCandidateInit | null>>([])
  const bufferedRemoteCandidatesRef = useRef<Array<RTCIceCandidateInit | null>>([])
  const localCandidateTypesRef = useRef(new Set<string>())
  const remoteCandidateTypesRef = useRef(new Set<string>())
  const iceErrorsRef = useRef<string[]>([])
  const iceRestartAttemptsRef = useRef(0)
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

  const sendSignal = useCallback(
    async (recipientId: string, kind: RtcSignalKind, payload: Record<string, unknown> = {}) => {
      if (!sessionId) return
      await pushRtcSignal({ roomId, senderId: myId, recipientId, sessionId, kind, payload })
    },
    [myId, roomId, sessionId],
  )

  const closeConnection = useCallback((nextStatus: P2PConnectionStatus = "idle") => {
    if (disconnectTimerRef.current !== null) {
      window.clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
    const connection = connectionRef.current
    connectionRef.current = null
    activePeerRef.current = null
    currentNegotiationRef.current = ""
    negotiatingRef.current = false
    localDescriptionSentRef.current = false
    bufferedLocalCandidatesRef.current = []
    bufferedRemoteCandidatesRef.current = []
    if (connection) {
      connection.ontrack = null
      connection.onicecandidate = null
      connection.onicecandidateerror = null
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

  const resetDiagnostics = useCallback(() => {
    localCandidateTypesRef.current = new Set<string>()
    remoteCandidateTypesRef.current = new Set<string>()
    iceErrorsRef.current = []
  }, [])

  const buildConnectionError = useCallback(() => {
    const local = candidateSummary(localCandidateTypesRef.current)
    const remote = candidateSummary(remoteCandidateTypesRef.current)
    const extra = iceErrorsRef.current.length > 0 ? ` Ошибка ICE: ${iceErrorsRef.current.slice(-1)[0]}.` : ""
    if (remoteCandidateTypesRef.current.size === 0) {
      return `ICE-кандидаты партнёра не были получены (локальные: ${local}). Примените миграцию 004_trickle_ice.sql и обновите обе вкладки.${extra}`
    }
    if (
      localCandidateTypesRef.current.size === 1 &&
      localCandidateTypesRef.current.has("host") &&
      remoteCandidateTypesRef.current.size === 1 &&
      remoteCandidateTypesRef.current.has("host")
    ) {
      return `Устройства обменялись только локальными ICE-кандидатами, но Wi‑Fi не пропустил прямой трафик. Проверьте, не включены ли Guest Wi‑Fi или AP/client isolation. ICE: ${local} ↔ ${remote}.${extra}`
    }
    return `Прямое P2P-соединение не установилось. ICE-кандидаты: локальные ${local}; удалённые ${remote}. Без TURN некоторые сети блокируют UDP или NAT hairpin.${extra}`
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
          iceRestartAttemptsRef.current = 0
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
          setError(buildConnectionError())
          if (isOwner && iceRestartAttemptsRef.current < MAX_ICE_RESTARTS) {
            iceRestartAttemptsRef.current += 1
            restartHostIceRef.current()
          } else {
            resetAfterFailure()
          }
        }
      }
      connection.oniceconnectionstatechange = () => {
        if (connection !== connectionRef.current || connection.iceConnectionState !== "failed") return
        setError(buildConnectionError())
        if (isOwner && iceRestartAttemptsRef.current < MAX_ICE_RESTARTS) {
          iceRestartAttemptsRef.current += 1
          restartHostIceRef.current()
        } else {
          resetAfterFailure()
        }
      }
    },
    [buildConnectionError, isOwner, resetAfterFailure],
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

  const sendIceCandidate = useCallback(
    async (recipientId: string, negotiationId: string, candidate: RTCIceCandidateInit | null) => {
      await sendSignal(recipientId, "ice-candidate", { negotiationId, candidate })
    },
    [sendSignal],
  )

  const flushLocalCandidates = useCallback(
    async (recipientId: string, negotiationId: string) => {
      const candidates = bufferedLocalCandidatesRef.current.splice(0)
      for (const candidate of candidates) await sendIceCandidate(recipientId, negotiationId, candidate)
    },
    [sendIceCandidate],
  )

  const configureCandidateSignaling = useCallback(
    (connection: RTCPeerConnection, recipientId: string, negotiationId: string) => {
      currentNegotiationRef.current = negotiationId
      localDescriptionSentRef.current = false
      bufferedLocalCandidatesRef.current = []
      bufferedRemoteCandidatesRef.current = []
      connection.onicecandidate = (event) => {
        if (connection !== connectionRef.current || currentNegotiationRef.current !== negotiationId) return
        const candidate = event.candidate?.toJSON() ?? null
        const type = getIceCandidateType(candidate)
        if (type) localCandidateTypesRef.current.add(type)
        if (!localDescriptionSentRef.current) {
          bufferedLocalCandidatesRef.current.push(candidate)
          return
        }
        void sendIceCandidate(recipientId, negotiationId, candidate).catch((reason) => {
          setError(
            reason instanceof Error
              ? `Не удалось передать ICE-кандидат: ${reason.message}. Проверьте миграцию 004_trickle_ice.sql.`
              : "Не удалось передать ICE-кандидат.",
          )
        })
      }
      connection.onicecandidateerror = (event) => {
        const details = event as Event & { errorText?: string; url?: string }
        const text = [details.errorText, details.url].filter(Boolean).join(" — ")
        if (text) iceErrorsRef.current = [...iceErrorsRef.current.slice(-2), text]
      }
    },
    [sendIceCandidate],
  )

  const drainRemoteCandidates = useCallback(async (connection: RTCPeerConnection) => {
    const candidates = bufferedRemoteCandidatesRef.current.splice(0)
    for (const candidate of candidates) await connection.addIceCandidate(candidate)
  }, [])

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
      resetDiagnostics()
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
        const negotiationId = crypto.randomUUID()
        configureCandidateSignaling(connection, viewerId, negotiationId)
        for (const track of stream.getTracks()) connection.addTrack(track, stream)
        await tuneMovieSenders(connection)
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        const description = connection.localDescription
        if (!description?.sdp) throw new Error("Browser did not create a WebRTC offer.")
        await sendSignal(viewerId, "offer", {
          type: description.type,
          sdp: description.sdp,
          negotiationId,
        })
        localDescriptionSentRef.current = true
        await flushLocalCandidates(viewerId, negotiationId)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось начать P2P-трансляцию.")
        resetAfterFailure()
      } finally {
        negotiatingRef.current = false
      }
    },
    [
      closeConnection,
      configureCandidateSignaling,
      createConnection,
      flushLocalCandidates,
      isOwner,
      p2pSource,
      resetAfterFailure,
      resetDiagnostics,
      sendSignal,
    ],
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
      const negotiationId = crypto.randomUUID()
      configureCandidateSignaling(connection, viewerId, negotiationId)
      connection.restartIce()
      const offer = await connection.createOffer({ iceRestart: true })
      await connection.setLocalDescription(offer)
      const description = connection.localDescription
      if (!description?.sdp) throw new Error("Browser did not create an ICE-restart offer.")
      await sendSignal(viewerId, "offer", {
        type: description.type,
        sdp: description.sdp,
        negotiationId,
      })
      localDescriptionSentRef.current = true
      await flushLocalCandidates(viewerId, negotiationId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : buildConnectionError())
      resetAfterFailure()
    } finally {
      negotiatingRef.current = false
    }
  }, [
    buildConnectionError,
    configureCandidateSignaling,
    flushLocalCandidates,
    isOwner,
    resetAfterFailure,
    sendSignal,
  ])
  restartHostIceRef.current = () => void restartHostIce()

  const acceptOffer = useCallback(
    async (senderId: string, payload: Record<string, unknown>) => {
      if (!p2pSource || isOwner || negotiatingRef.current || !isSessionDescriptionPayload(payload) || payload.type !== "offer") return
      closeConnection("connecting")
      resetDiagnostics()
      negotiatingRef.current = true
      try {
        const connection = createConnection()
        activePeerRef.current = senderId
        configureCandidateSignaling(connection, senderId, payload.negotiationId)
        const incoming = new MediaStream()
        connection.ontrack = (event) => {
          const tracks = event.streams[0]?.getTracks() ?? [event.track]
          for (const track of tracks) {
            if (!incoming.getTracks().some((current) => current.id === track.id)) incoming.addTrack(track)
          }
          setRemoteStream(new MediaStream(incoming.getTracks()))
        }
        await connection.setRemoteDescription({ type: payload.type, sdp: payload.sdp })
        await drainRemoteCandidates(connection)
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        const description = connection.localDescription
        if (!description?.sdp) throw new Error("Browser did not create a WebRTC answer.")
        await sendSignal(senderId, "answer", {
          type: description.type,
          sdp: description.sdp,
          negotiationId: payload.negotiationId,
        })
        localDescriptionSentRef.current = true
        await flushLocalCandidates(senderId, payload.negotiationId)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось подключиться к трансляции.")
        resetAfterFailure()
      } finally {
        negotiatingRef.current = false
      }
    },
    [
      closeConnection,
      configureCandidateSignaling,
      createConnection,
      drainRemoteCandidates,
      flushLocalCandidates,
      isOwner,
      p2pSource,
      resetAfterFailure,
      resetDiagnostics,
      sendSignal,
    ],
  )

  const acceptAnswer = useCallback(
    async (senderId: string, payload: Record<string, unknown>) => {
      const connection = connectionRef.current
      if (
        !isOwner ||
        !connection ||
        activePeerRef.current !== senderId ||
        !isSessionDescriptionPayload(payload) ||
        payload.type !== "answer" ||
        payload.negotiationId !== currentNegotiationRef.current
      ) return
      if (connection.signalingState !== "have-local-offer") return
      try {
        await connection.setRemoteDescription({ type: payload.type, sdp: payload.sdp })
        await drainRemoteCandidates(connection)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Не удалось завершить WebRTC-соединение.")
        resetAfterFailure()
      }
    },
    [drainRemoteCandidates, isOwner, resetAfterFailure],
  )

  const acceptIceCandidate = useCallback(
    async (senderId: string, payload: Record<string, unknown>) => {
      const connection = connectionRef.current
      const parsed = parseIceCandidatePayload(payload)
      if (
        !connection ||
        !parsed ||
        activePeerRef.current !== senderId ||
        parsed.negotiationId !== currentNegotiationRef.current
      ) return
      const type = getIceCandidateType(parsed.candidate)
      if (type) remoteCandidateTypesRef.current.add(type)
      if (!connection.remoteDescription) {
        bufferedRemoteCandidatesRef.current.push(parsed.candidate)
        return
      }
      try {
        await connection.addIceCandidate(parsed.candidate)
      } catch (reason) {
        setError(reason instanceof Error ? `ICE-кандидат отклонён: ${reason.message}` : "ICE-кандидат отклонён.")
      }
    },
    [],
  )

  useEffect(() => {
    lastSignalIdRef.current = 0
    setError(null)
    iceRestartAttemptsRef.current = 0
    resetDiagnostics()
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
  }, [closeConnection, isOwner, ownerId, p2pSource?.sourceId, resetDiagnostics, sessionId])

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
          } else if (signal.kind === "ice-candidate") {
            await acceptIceCandidate(signal.senderId, signal.payload)
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
  }, [
    acceptAnswer,
    acceptIceCandidate,
    acceptOffer,
    isOwner,
    myId,
    ownerId,
    p2pSource,
    resetAfterFailure,
    roomId,
    sessionId,
    startHostOffer,
  ])

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
