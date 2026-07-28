"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, Check, Copy, Radio, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VideoPlayer, type VideoPlayerHandle } from "@/components/video-player"
import { Chat } from "@/components/chat"
import { SourceControls } from "@/components/source-controls"
import { useRoomChannel } from "@/hooks/use-room-channel"
import { useP2PStream } from "@/hooks/use-p2p-stream"
import {
  clearCachedSnapshot,
  dedupeMessages,
  leaveRoom,
  loadCachedSnapshot,
  loadRemoteSnapshot,
  mergeSnapshots,
  persistRoomMessage,
  persistRoomState,
  saveCachedSnapshot,
  touchRoomMember,
} from "@/lib/room-store"
import {
  clearRoomFileHandle,
  loadRoomFileHandle,
  queryFilePermission,
  requestFilePermission,
  saveRoomFileHandle,
} from "@/lib/file-handle-store"
import { normalizeVideoUrl } from "@/lib/room"
import {
  chooseNewestState,
  compareRevisions,
  nextRevision,
  shouldApplyRevision,
  ZERO_REVISION,
} from "@/lib/playback-sync"
import type {
  ChatEvent,
  ChatItem,
  LogicalRevision,
  PersistedRoomState,
  PlayerAction,
  SourceInfo,
} from "@/lib/sync-types"

const DRIFT_THRESHOLD = 1.25
const HEARTBEAT_MS = 5_000
const MEMBER_TOUCH_MS = 20_000
const CONNECTED_POLL_MS = 2_000
const FALLBACK_POLL_MS = 1_500
const RESTORE_ADVANCE_CAP_SECONDS = 5

function sourceKey(source: SourceInfo | null): string {
  return source?.sourceId ?? "none"
}

function formatBytes(value?: number): string {
  if (!value || value < 1) return ""
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function WatchRoom({ roomId, userName }: { roomId: string; userName: string }) {
  const router = useRouter()
  const playerRef = useRef<VideoPlayerHandle>(null)

  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [src, setSrc] = useState<string | null>(null)
  const [currentSource, setCurrentSource] = useState<SourceInfo | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [canRestoreFile, setCanRestoreFile] = useState(false)

  const sourceRef = useRef<SourceInfo | null>(null)
  const srcRef = useRef<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatEvent[]>([])
  const latestStateRef = useRef<PersistedRoomState | null>(null)
  const pendingPlaybackRef = useRef<PersistedRoomState | null>(null)
  const pendingPersistRef = useRef<PersistedRoomState | null>(null)
  const persistenceRunningRef = useRef(false)
  const persistenceStoppedRef = useRef(false)
  const channelRef = useRef<ReturnType<typeof useRoomChannel> | null>(null)
  const localCounterRef = useRef(0)
  const lastAppliedRevisionRef = useRef<LogicalRevision>(ZERO_REVISION)
  srcRef.current = src

  const replaceSourceUrl = useCallback((nextSrc: string | null, objectUrl: string | null = null) => {
    if (objectUrlRef.current && objectUrlRef.current !== objectUrl) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = objectUrl
    setSrc(nextSrc)
  }, [])

  const cacheSnapshot = useCallback(
    (state = latestStateRef.current, messages = messagesRef.current) => {
      saveCachedSnapshot(roomId, { state, messages })
    },
    [roomId],
  )

  const setChatMessages = useCallback(
    (messages: ChatEvent[]) => {
      const deduped = dedupeMessages(messages).slice(-500)
      messagesRef.current = deduped
      setChatItems((previous) => {
        const system = previous.filter((item) => item.kind === "system")
        return [...system, ...deduped.map((message) => ({ kind: "chat" as const, ...message }))].sort(
          (a, b) => a.at - b.at,
        )
      })
      cacheSnapshot(latestStateRef.current, deduped)
    },
    [cacheSnapshot],
  )

  const appendChat = useCallback((message: ChatEvent) => setChatMessages([...messagesRef.current, message]), [setChatMessages])
  const pushSystem = useCallback((text: string) => {
    setChatItems((previous) => [...previous, { kind: "system", id: crypto.randomUUID(), text, at: Date.now() }])
  }, [])

  const issueRevision = useCallback((): LogicalRevision => {
    const senderId = channelRef.current?.myId ?? ""
    const revision = nextRevision(senderId, localCounterRef.current, lastAppliedRevisionRef.current)
    localCounterRef.current = revision.counter
    lastAppliedRevisionRef.current = revision
    return revision
  }, [])

  const currentState = useCallback(
    (overrides: Partial<PersistedRoomState> = {}): PersistedRoomState => {
      const player = playerRef.current
      return {
        source: overrides.source === undefined ? sourceRef.current : overrides.source,
        videoTime: overrides.videoTime === undefined ? Math.max(0, player?.getTime() ?? 0) : overrides.videoTime,
        playing: overrides.playing === undefined ? Boolean(player && !player.isPaused()) : overrides.playing,
        revision: overrides.revision ?? lastAppliedRevisionRef.current,
        updatedAt: overrides.updatedAt ?? Date.now(),
        updatedBy: overrides.updatedBy ?? channelRef.current?.myId ?? "",
      }
    },
    [],
  )

  const queuePersistState = useCallback(
    (state: PersistedRoomState) => {
      latestStateRef.current = state
      pendingPersistRef.current = chooseNewestState(pendingPersistRef.current, state)
      cacheSnapshot(state)
      if (persistenceRunningRef.current) return
      persistenceRunningRef.current = true
      void (async () => {
        let retryDelay = 500
        while (!persistenceStoppedRef.current && pendingPersistRef.current) {
          const next = pendingPersistRef.current
          pendingPersistRef.current = null
          try {
            await persistRoomState(roomId, next)
            retryDelay = 500
            setPersistenceError(null)
          } catch (error) {
            pendingPersistRef.current = chooseNewestState(next, pendingPersistRef.current)
            setPersistenceError(
              error instanceof Error
                ? `Состояние комнаты не сохранено и будет повторено: ${error.message}`
                : "Состояние комнаты не сохранено и будет повторено.",
            )
            await new Promise((resolve) => window.setTimeout(resolve, retryDelay))
            retryDelay = Math.min(5_000, retryDelay * 2)
          }
        }
        persistenceRunningRef.current = false
      })()
    },
    [cacheSnapshot, roomId],
  )

  const playbackTarget = useCallback((state: PersistedRoomState, advancePlaying: boolean) => {
    if (!advancePlaying || !state.playing) return state.videoTime
    return state.videoTime + Math.min(RESTORE_ADVANCE_CAP_SECONDS, Math.max(0, (Date.now() - state.updatedAt) / 1000))
  }, [])

  const applyPlayback = useCallback(
    (state: PersistedRoomState, advancePlaying: boolean) => {
      if (state.source?.kind === "p2p") return false
      const player = playerRef.current
      if (!player || !srcRef.current || !player.isReady()) {
        pendingPlaybackRef.current = state
        return false
      }
      pendingPlaybackRef.current = null
      void player.applyState(playbackTarget(state, advancePlaying), state.playing)
      return true
    },
    [playbackTarget],
  )

  const setSource = useCallback(
    (source: SourceInfo | null) => {
      sourceRef.current = source
      setCurrentSource(source)
      setVideoError(null)
      if (!source) {
        replaceSourceUrl(null)
        setHint(null)
      } else if (source.kind === "url" && source.url) {
        replaceSourceUrl(source.url)
        setHint(null)
      } else if (source.kind === "p2p") {
        if (source.ownerId !== channelRef.current?.myId) replaceSourceUrl(null)
        setHint(
          source.ownerId === channelRef.current?.myId
            ? "Вы владелец трансляции. Управление плеером у вас; партнёр видит тот же поток."
            : `Владелец транслирует «${source.label}». Управление воспроизведением находится у него.`,
        )
      }
    },
    [replaceSourceUrl],
  )

  const applyPersistedState = useCallback(
    (state: PersistedRoomState | null, advancePlaying = true) => {
      if (!state) return
      const previous = latestStateRef.current
      const order = compareRevisions(state.revision, lastAppliedRevisionRef.current)
      if (order < 0 || (order === 0 && previous && state.updatedAt <= previous.updatedAt)) return
      lastAppliedRevisionRef.current = state.revision
      localCounterRef.current = Math.max(localCounterRef.current, state.revision.counter)
      latestStateRef.current = state
      cacheSnapshot(state)

      if (sourceKey(state.source) !== sourceKey(sourceRef.current)) setSource(state.source)
      if (state.source?.kind === "p2p") return

      const player = playerRef.current
      if (!player || !srcRef.current) {
        pendingPlaybackRef.current = state
        return
      }
      const target = playbackTarget(state, advancePlaying)
      if (order > 0 || Math.abs(player.getTime() - target) > DRIFT_THRESHOLD || player.isPaused() === state.playing) {
        applyPlayback(state, advancePlaying)
      }
    },
    [applyPlayback, cacheSnapshot, playbackTarget, setSource],
  )

  const channel = useRoomChannel({
    roomId,
    userName,
    handlers: {
      onSystem: pushSystem,
      onChat: (message) => {
        appendChat(message)
        void persistRoomMessage(roomId, message).catch(() => undefined)
      },
      onSource: (info) => {
        pushSystem(info.kind === "p2p" ? `Партнёр начал P2P-трансляцию «${info.label}»` : `Партнёр открыл «${info.label}»`)
      },
      onPlayer: (event) => {
        const source = sourceRef.current
        if (!source || source.kind !== "url" || event.sourceId !== source.sourceId) return
        if (!shouldApplyRevision(event.revision, lastAppliedRevisionRef.current)) return
        lastAppliedRevisionRef.current = event.revision
        localCounterRef.current = Math.max(localCounterRef.current, event.revision.counter)
        const state: PersistedRoomState = {
          source,
          videoTime: event.videoTime,
          playing: event.playing,
          revision: event.revision,
          updatedAt: event.at,
          updatedBy: event.senderId,
        }
        latestStateRef.current = state
        cacheSnapshot(state)
        applyPlayback(state, false)
        queuePersistState(state)
      },
      onStateRequest: (fromId) => {
        const api = channelRef.current
        const source = sourceRef.current
        if (!api || !source) return
        const state = currentState()
        api.sendState({
          source,
          videoTime: state.videoTime,
          playing: state.playing,
          revision: state.revision,
          reason: "join",
          toId: fromId,
        })
      },
      onStateResponse: (response) => {
        const api = channelRef.current
        if (!api || (response.reason === "join" && response.toId !== api.myId)) return
        applyPersistedState({
          source: response.source,
          videoTime: response.videoTime,
          playing: response.playing,
          revision: response.revision,
          updatedAt: response.at,
          updatedBy: response.senderId,
        }, response.reason !== "source")
      },
    },
  })
  channelRef.current = channel

  const p2p = useP2PStream({
    roomId,
    myId: channel.myId,
    source: currentSource,
    getLocalStream: async () => playerRef.current?.getCaptureStream() ?? null,
  })

  const isP2PViewer = currentSource?.kind === "p2p" && currentSource.ownerId !== channel.myId
  const timekeeperId = useMemo(() => {
    if (!channel.partner) return channel.myId
    return [channel.myId, channel.partner.id].sort()[0]
  }, [channel.myId, channel.partner])

  const restoreFileFromHandle = useCallback(async (requestPermission: boolean) => {
    const source = sourceRef.current
    if (!source || source.kind !== "p2p" || source.ownerId !== channel.myId) return
    try {
      const handle = await loadRoomFileHandle(roomId)
      if (!handle) {
        setCanRestoreFile(false)
        return
      }
      const permission = requestPermission ? await requestFilePermission(handle) : await queryFilePermission(handle)
      if (permission !== "granted") {
        setCanRestoreFile(true)
        return
      }
      const file = await handle.getFile()
      if (file.name !== source.label || (source.fileSize !== undefined && file.size !== source.fileSize)) {
        setCanRestoreFile(true)
        setVideoError("Сохранённый локальный файл не совпадает с текущей трансляцией. Выберите его заново.")
        return
      }
      const objectUrl = URL.createObjectURL(file)
      replaceSourceUrl(objectUrl, objectUrl)
      setCanRestoreFile(false)
      setHint("Локальный файл восстановлен. Трансляция продолжится после подключения партнёра.")
    } catch (error) {
      setCanRestoreFile(true)
      setVideoError(error instanceof Error ? error.message : "Не удалось восстановить доступ к файлу.")
    }
  }, [channel.myId, replaceSourceUrl, roomId])

  useEffect(() => {
    if (currentSource?.kind === "p2p" && currentSource.ownerId === channel.myId && !src) {
      void restoreFileFromHandle(false)
    } else {
      setCanRestoreFile(false)
    }
  }, [channel.myId, currentSource?.sourceId, restoreFileFromHandle, src])

  useEffect(() => {
    persistenceStoppedRef.current = false
    const cached = loadCachedSnapshot(roomId)
    setChatMessages(cached.messages)
    applyPersistedState(cached.state)
    let active = true
    void loadRemoteSnapshot(roomId)
      .then((remote) => {
        if (!active) return
        const merged = mergeSnapshots(cached, remote)
        saveCachedSnapshot(roomId, merged)
        setChatMessages(merged.messages)
        applyPersistedState(merged.state)
        setPersistenceError(null)
      })
      .catch((error) => {
        if (active) setPersistenceError(error instanceof Error ? `Supabase недоступен: ${error.message}. Выполните миграцию 003.` : "Supabase недоступен. Выполните миграцию 003.")
      })
    return () => {
      active = false
      persistenceStoppedRef.current = true
    }
  }, [applyPersistedState, roomId, setChatMessages])

  useEffect(() => {
    let running = false
    const delay = channel.status === "connected" ? CONNECTED_POLL_MS : FALLBACK_POLL_MS
    const poll = async () => {
      if (running) return
      running = true
      try {
        const remote = await loadRemoteSnapshot(roomId)
        setChatMessages([...messagesRef.current, ...remote.messages])
        applyPersistedState(remote.state)
      } catch {
        // Visible banners explain degraded state.
      } finally {
        running = false
      }
    }
    const interval = window.setInterval(() => void poll(), delay)
    return () => window.clearInterval(interval)
  }, [applyPersistedState, channel.status, roomId, setChatMessages])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const source = sourceRef.current
      const player = playerRef.current
      if (!source || !player) return
      if (source.kind === "p2p" && source.ownerId !== channel.myId) return
      if (source.kind === "url" && channel.myId !== timekeeperId) return
      const state = currentState()
      if (source.kind === "url") {
        channel.sendState({ source, videoTime: state.videoTime, playing: state.playing, revision: state.revision, reason: "heartbeat" })
      }
      queuePersistState(state)
    }, HEARTBEAT_MS)
    return () => window.clearInterval(interval)
  }, [channel.myId, channel.sendState, currentState, queuePersistState, timekeeperId])

  useEffect(() => {
    const touch = () => void touchRoomMember(roomId, channel.myId).catch(() => undefined)
    touch()
    const interval = window.setInterval(touch, MEMBER_TOUCH_MS)
    return () => window.clearInterval(interval)
  }, [channel.myId, roomId])

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  const publishSourceState = useCallback((source: Omit<SourceInfo, "senderId" | "revision">) => {
    const revision = issueRevision()
    const shared = channel.sendSource({ ...source, revision })
    setSource(shared)
    const state = currentState({ source: shared, videoTime: 0, playing: false, revision })
    channel.sendState({ source: shared, videoTime: 0, playing: false, revision, reason: "source" })
    queuePersistState(state)
    return shared
  }, [channel, currentState, issueRevision, queuePersistState, setSource])

  const handleUrl = useCallback((input: string) => {
    const url = normalizeVideoUrl(input)
    if (!url) {
      setVideoError("Введите корректную прямую http:// или https:// ссылку.")
      return
    }
    setVideoError(null)
    replaceSourceUrl(url)
    publishSourceState({ kind: "url", sourceId: crypto.randomUUID(), label: url, url, duration: null })
  }, [publishSourceState, replaceSourceUrl])

  const handleFile = useCallback((file: File, handle?: FileSystemFileHandle) => {
    setVideoError(null)
    setCanRestoreFile(false)
    const objectUrl = URL.createObjectURL(file)
    replaceSourceUrl(objectUrl, objectUrl)
    if (handle) void saveRoomFileHandle(roomId, handle).catch(() => undefined)
    else void clearRoomFileHandle(roomId).catch(() => undefined)
    publishSourceState({
      kind: "p2p",
      sourceId: crypto.randomUUID(),
      streamSessionId: crypto.randomUUID(),
      ownerId: channel.myId,
      label: file.name,
      fileSize: file.size,
      mimeType: file.type || "video/mp4",
      lastModified: file.lastModified,
      duration: null,
    })
    setHint("Файл готов локально. Нажмите Play — партнёр получит живой поток напрямую от вас.")
  }, [channel.myId, publishSourceState, replaceSourceUrl, roomId])

  const broadcastPlayerState = useCallback((action: PlayerAction, playing: boolean) => {
    const player = playerRef.current
    const source = sourceRef.current
    if (!player || !source) return
    const revision = issueRevision()
    const videoTime = Math.max(0, player.getTime())
    const state = currentState({ source, videoTime, playing, revision })
    if (source.kind === "url") {
      channel.sendPlayer({ action, videoTime, playing, sourceId: source.sourceId, revision })
    }
    // For P2P the owner is authoritative: the remote participant sees the
    // captured media directly, so no synthetic seek/pause command is needed.
    queuePersistState(state)
  }, [channel, currentState, issueRevision, queuePersistState])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setPersistenceError("Не удалось скопировать код комнаты.")
    }
  }

  const handleLeave = async () => {
    if (leaving) return
    setLeaving(true)
    try {
      await leaveRoom(roomId, channel.myId)
      clearCachedSnapshot(roomId)
      await clearRoomFileHandle(roomId).catch(() => undefined)
    } finally {
      router.push("/")
    }
  }

  if (channel.status === "full") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <Users className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">Комната заполнена</h1>
        <p className="max-w-sm text-sm text-muted-foreground">В комнате могут находиться только два участника.</p>
        <Button onClick={() => router.push("/")}>На главную</Button>
      </div>
    )
  }

  const p2pDetails = currentSource?.kind === "p2p"
    ? `${formatBytes(currentSource.fileSize)}${p2p.stats.bitrateKbps ? ` · ${Math.round(p2p.stats.bitrateKbps)} Кбит/с` : ""}${p2p.stats.roundTripMs ? ` · ${Math.round(p2p.stats.roundTripMs)} мс` : ""}`
    : ""

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleLeave} disabled={leaving} aria-label="Выйти">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <p className="text-xs text-muted-foreground">Код комнаты</p>
            <button onClick={copyCode} className="flex items-center gap-2 font-mono text-lg font-semibold tracking-widest text-foreground">
              {roomId}
              {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
        </div>
        <StatusPill status={channel.status} hasPartner={Boolean(channel.partner)} partnerName={channel.partner?.name} />
      </header>

      {videoError && <Banner tone="error">{videoError}</Banner>}
      {persistenceError && <Banner tone="warning">{persistenceError}</Banner>}
      {p2p.error && <Banner tone="warning">{p2p.error}</Banner>}
      {channel.connectionError && <Banner tone="warning">Realtime: {channel.connectionError}. Чат и сигналинг продолжают работать через Postgres RPC.</Banner>}
      {!channel.partner && channel.status === "connected" && <Banner tone="info">Ожидание партнёра — отправьте ему код <strong>{roomId}</strong>.</Banner>}
      {currentSource?.kind === "p2p" && (
        <Banner tone="info">
          <span className="inline-flex items-center gap-2"><Radio className="h-4 w-4" /> P2P: {p2pStatusLabel(p2p.status)}{p2pDetails ? ` · ${p2pDetails}` : ""}</span>
        </Banner>
      )}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <VideoPlayer
            ref={playerRef}
            src={isP2PViewer ? null : src}
            stream={isP2PViewer ? p2p.remoteStream : null}
            readOnly={isP2PViewer}
            emptyText={
              isP2PViewer
                ? "Подключаемся к прямой трансляции владельца…"
                : currentSource?.kind === "p2p"
                  ? "Восстановите или выберите локальный файл для продолжения трансляции."
                  : "Выберите видео или вставьте прямую ссылку."
            }
            onLoadedMetadata={(duration) => {
              const source = sourceRef.current
              if (!source) return
              const updated = { ...source, duration }
              sourceRef.current = updated
              setCurrentSource(updated)
              queuePersistState(currentState({ source: updated }))
              const pending = pendingPlaybackRef.current
              if (pending && source.kind === "url") applyPlayback(pending, true)
            }}
            onError={setVideoError}
            onPlay={() => broadcastPlayerState("play", true)}
            onPause={() => broadcastPlayerState("pause", false)}
            onSeeked={() => broadcastPlayerState("seek", Boolean(playerRef.current && !playerRef.current.isPaused()))}
          />
          <SourceControls
            onUrl={handleUrl}
            onFile={handleFile}
            onRestore={() => void restoreFileFromHandle(true)}
            canRestore={canRestoreFile}
            hint={hint}
          />
        </div>

        <div className="h-[420px] lg:h-auto">
          <Chat
            items={chatItems}
            myId={channel.myId}
            onSend={(text) => {
              const message = channel.sendChat(text)
              appendChat(message)
              void persistRoomMessage(roomId, message).catch((error) => {
                setPersistenceError(error instanceof Error ? `Сообщение отправлено, но не сохранено: ${error.message}` : "Сообщение не сохранено.")
              })
            }}
          />
        </div>
      </div>
    </main>
  )
}

function p2pStatusLabel(status: string): string {
  switch (status) {
    case "waiting-owner": return "ожидание владельца"
    case "waiting-viewer": return "ожидание зрителя"
    case "connecting": return "установка прямого соединения"
    case "connected": return "прямое соединение установлено"
    case "reconnecting": return "переподключение"
    case "unsupported": return "браузер не поддерживается"
    case "failed": return "соединение не установлено"
    default: return "неактивно"
  }
}

function StatusPill({ status, hasPartner, partnerName }: { status: string; hasPartner: boolean; partnerName?: string }) {
  const online = status === "connected" && hasPartner
  const label = status === "connecting"
    ? "Подключение…"
    : status === "reconnecting"
      ? "HTTP fallback"
      : status === "error"
        ? "Ошибка соединения"
        : online
          ? `${partnerName ?? "Партнёр"} подключён`
          : "Ожидание партнёра"
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
      <span className={`h-2 w-2 rounded-full ${online ? "bg-primary" : "bg-muted-foreground"}`} />
      <span className="text-card-foreground">{label}</span>
    </div>
  )
}

function Banner({ children, tone }: { children: React.ReactNode; tone: "info" | "warning" | "error" }) {
  const classes = tone === "error"
    ? "border-destructive/40 bg-destructive/10 text-destructive"
    : tone === "warning"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-border bg-card text-card-foreground"
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${classes}`}>
      {tone !== "info" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <div>{children}</div>
    </div>
  )
}
