"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, Check, Copy, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VideoPlayer, type VideoPlayerHandle } from "@/components/video-player"
import { Chat } from "@/components/chat"
import { SourceControls } from "@/components/source-controls"
import { useRoomChannel } from "@/hooks/use-room-channel"
import {
  dedupeMessages,
  loadCachedSnapshot,
  loadRemoteSnapshot,
  mergeSnapshots,
  persistRoomMessage,
  persistRoomState,
  removeStoredVideo,
  saveCachedSnapshot,
} from "@/lib/room-store"
import { normalizeVideoUrl } from "@/lib/room"
import { uploadRoomVideo } from "@/lib/storage-upload"
import type {
  ChatEvent,
  ChatItem,
  PersistedRoomState,
  SourceInfo,
} from "@/lib/sync-types"

const DRIFT_THRESHOLD = 1
const HEARTBEAT_MS = 4000
const ECHO_WINDOW_MS = 700
const RESTORE_ADVANCE_CAP_SECONDS = 15

function sourceKey(source: SourceInfo | null): string {
  if (!source) return "none"
  return `${source.kind}:${source.storagePath ?? source.url ?? source.label}`
}

export function WatchRoom({ roomId, userName }: { roomId: string; userName: string }) {
  const router = useRouter()
  const playerRef = useRef<VideoPlayerHandle>(null)

  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [src, setSrc] = useState<string | null>(null)
  const [myDuration, setMyDuration] = useState<number | null>(null)
  const myDurationRef = useRef<number | null>(null)
  const [partnerSource, setPartnerSource] = useState<SourceInfo | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)

  const suppressEventsUntil = useRef(0)
  const buffering = useRef(false)
  const mySourceRef = useRef<SourceInfo | null>(null)
  const srcRef = useRef<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatEvent[]>([])
  const latestStateRef = useRef<PersistedRoomState | null>(null)
  const latestAppliedStateAt = useRef(0)
  const pendingRestoreRef = useRef<PersistedRoomState | null>(null)
  const uploadControllerRef = useRef<AbortController | null>(null)
  const uploadTokenRef = useRef(0)
  const pendingPersistRef = useRef<PersistedRoomState | null>(null)
  const persistenceRunningRef = useRef(false)
  const announcedSourceRef = useRef("")
  const channelRef = useRef<ReturnType<typeof useRoomChannel> | null>(null)
  srcRef.current = src

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

  const appendChat = useCallback(
    (message: ChatEvent) => {
      setChatMessages([...messagesRef.current, message])
    },
    [setChatMessages],
  )

  const pushSystem = useCallback((text: string) => {
    setChatItems((previous) => [
      ...previous,
      { kind: "system", id: crypto.randomUUID(), text, at: Date.now() },
    ])
  }, [])

  const replaceSourceUrl = useCallback((nextSrc: string | null, objectUrl: string | null = null) => {
    if (objectUrlRef.current && objectUrlRef.current !== objectUrl) {
      URL.revokeObjectURL(objectUrlRef.current)
    }
    objectUrlRef.current = objectUrl
    setSrc(nextSrc)
  }, [])

  const withRemote = useCallback((fn: () => void) => {
    suppressEventsUntil.current = Math.max(suppressEventsUntil.current, Date.now() + ECHO_WINDOW_MS)
    fn()
  }, [])

  const isRemoteEventSuppressed = () => Date.now() < suppressEventsUntil.current

  const restorePlayback = useCallback(
    (state: PersistedRoomState) => {
      const player = playerRef.current
      if (!player || !srcRef.current || player.getDuration() <= 0) {
        pendingRestoreRef.current = state
        return false
      }

      pendingRestoreRef.current = null
      const elapsed = state.playing
        ? Math.min(
            RESTORE_ADVANCE_CAP_SECONDS,
            Math.max(0, (Date.now() - state.updatedAt) / 1000),
          )
        : 0
      withRemote(() => {
        player.seek(state.videoTime + elapsed)
        if (state.playing) void player.play()
        else player.pause()
      })
      return true
    },
    [withRemote],
  )

  const queuePersistState = useCallback(
    (state: PersistedRoomState) => {
      latestStateRef.current = state
      pendingPersistRef.current = state
      cacheSnapshot(state)

      if (persistenceRunningRef.current) return
      persistenceRunningRef.current = true

      void (async () => {
        while (pendingPersistRef.current) {
          const next = pendingPersistRef.current
          pendingPersistRef.current = null
          try {
            await persistRoomState(roomId, next)
            setPersistenceError(null)
          } catch (error) {
            setPersistenceError(
              error instanceof Error
                ? `Room history is only saved on this device: ${error.message}`
                : "Room history is only saved on this device.",
            )
          }
        }
        persistenceRunningRef.current = false
      })()
    },
    [cacheSnapshot, roomId],
  )

  const currentState = useCallback(
    (overrides: Partial<Pick<PersistedRoomState, "source" | "videoTime" | "playing">> = {}) => {
      const player = playerRef.current
      return {
        source: overrides.source === undefined ? mySourceRef.current : overrides.source,
        videoTime:
          overrides.videoTime === undefined ? Math.max(0, player?.getTime() ?? 0) : overrides.videoTime,
        playing:
          overrides.playing === undefined ? Boolean(player && !player.isPaused()) : overrides.playing,
        updatedAt: Date.now(),
        updatedBy: channelRef.current?.myId ?? "",
      } satisfies PersistedRoomState
    },
    [],
  )

  const loadSharedSource = useCallback(
    (source: SourceInfo, restore?: PersistedRoomState | null) => {
      if ((source.kind === "url" || source.kind === "storage") && source.url) {
        buffering.current = false
        setVideoError(null)
        setHint(null)
        setMyDuration(null)
        myDurationRef.current = null
        mySourceRef.current = source
        replaceSourceUrl(source.url)
        if (restore) pendingRestoreRef.current = restore
      } else if (source.kind === "uploading") {
        setPartnerSource(source)
        setHint(`Your partner is uploading “${source.label}”. It will open automatically when ready.`)
      }
    },
    [replaceSourceUrl],
  )

  const applyPersistedState = useCallback(
    (state: PersistedRoomState | null) => {
      if (!state || state.updatedAt < latestAppliedStateAt.current) return
      latestAppliedStateAt.current = state.updatedAt
      latestStateRef.current = state

      if (state.source && sourceKey(state.source) !== sourceKey(mySourceRef.current)) {
        loadSharedSource(state.source, state)
      } else if (state.source) {
        restorePlayback(state)
      }
      cacheSnapshot(state)
    },
    [cacheSnapshot, loadSharedSource, restorePlayback],
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
        setPartnerSource(info)
        const key = sourceKey(info)
        if (announcedSourceRef.current !== key) {
          announcedSourceRef.current = key
          pushSystem(
            info.kind === "uploading"
              ? `Partner is uploading “${info.label}”`
              : `Partner loaded “${info.label}”`,
          )
        }

        if (info.kind === "uploading") {
          setHint(`Your partner is uploading “${info.label}”. It will open automatically when ready.`)
          return
        }

        uploadTokenRef.current += 1
        uploadControllerRef.current?.abort()
        uploadControllerRef.current = null
        setUploading(false)
        loadSharedSource(info)
        const state = currentState({ source: info, videoTime: 0, playing: false })
        latestStateRef.current = state
        cacheSnapshot(state)
      },
      onPlayer: (event) => {
        const player = playerRef.current
        if (!player || !srcRef.current) return
        const delay = Math.max(0, (Date.now() - event.at) / 1000)

        switch (event.action) {
          case "play":
          case "resume":
            withRemote(() => {
              player.seek(event.videoTime + delay)
              void player.play()
            })
            break
          case "pause":
            withRemote(() => {
              player.seek(event.videoTime)
              player.pause()
            })
            break
          case "buffer":
            withRemote(() => player.pause())
            break
          case "seek":
            // A seek is an absolute position; network delay must not be added.
            withRemote(() => player.seek(event.videoTime))
            break
        }
      },
      onStateRequest: (fromId) => {
        const api = channelRef.current
        const player = playerRef.current
        if (!api || !mySourceRef.current || mySourceRef.current.kind === "uploading" || !player) return
        api.sendState({
          source: mySourceRef.current,
          videoTime: player.getTime(),
          playing: !player.isPaused(),
          reason: "join",
          toId: fromId,
        })
      },
      onStateResponse: (response) => {
        const api = channelRef.current
        if (!api) return
        setPartnerSource(response.source)

        if (response.reason === "join" && response.toId !== api.myId) return
        if (response.reason === "heartbeat" && api.myId === timekeeperIdRef.current) return

        const responseState: PersistedRoomState = {
          source: response.source,
          videoTime: response.videoTime,
          playing: response.playing,
          updatedAt: response.at,
          updatedBy: response.senderId,
        }

        if (response.source && sourceKey(response.source) !== sourceKey(mySourceRef.current)) {
          loadSharedSource(response.source, responseState)
          return
        }

        const player = playerRef.current
        if (!player || !srcRef.current) return
        const expected =
          response.videoTime +
          (response.playing ? Math.max(0, (Date.now() - response.at) / 1000) : 0)
        const mine = player.getTime()

        withRemote(() => {
          if (
            response.reason === "join" ||
            response.reason === "source" ||
            Math.abs(expected - mine) > DRIFT_THRESHOLD
          ) {
            player.seek(expected)
          }
          if (response.playing) void player.play()
          else player.pause()
        })
      },
    },
  })
  channelRef.current = channel

  const timekeeperId = useMemo(() => {
    if (!channel.partner) return channel.myId
    return [channel.myId, channel.partner.id].sort()[0]
  }, [channel.myId, channel.partner])
  const timekeeperIdRef = useRef(timekeeperId)
  timekeeperIdRef.current = timekeeperId

  // Restore cached data immediately, then merge the authoritative Supabase snapshot.
  useEffect(() => {
    let active = true
    const cached = loadCachedSnapshot(roomId)
    setChatMessages(cached.messages)
    applyPersistedState(cached.state)

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
        if (!active) return
        setPersistenceError(
          error instanceof Error
            ? `Supabase persistence is unavailable: ${error.message}. Apply the included migration.`
            : "Supabase persistence is unavailable. Apply the included migration.",
        )
      })

    return () => {
      active = false
    }
  }, [applyPersistedState, roomId, setChatMessages])

  // Heartbeat: one deterministic participant owns clock correction and persistence.
  useEffect(() => {
    if (!channel.partner || channel.myId !== timekeeperId) return
    const interval = window.setInterval(() => {
      const player = playerRef.current
      if (!player || !mySourceRef.current || mySourceRef.current.kind === "uploading") return
      const state = currentState()
      channel.sendState({
        source: state.source,
        videoTime: state.videoTime,
        playing: state.playing,
        reason: "heartbeat",
      })
      queuePersistState(state)
    }, HEARTBEAT_MS)
    return () => window.clearInterval(interval)
  }, [channel.myId, channel.partner, channel.sendState, currentState, queuePersistState, timekeeperId])

  // Always keep a synchronous local snapshot on refresh/navigation.
  useEffect(() => {
    const save = () => {
      if (
        mySourceRef.current &&
        mySourceRef.current.kind !== "uploading" &&
        playerRef.current
      ) {
        const state = currentState()
        latestStateRef.current = state
      }
      cacheSnapshot()
    }
    window.addEventListener("pagehide", save)
    return () => window.removeEventListener("pagehide", save)
  }, [cacheSnapshot, currentState])

  useEffect(
    () => () => {
      uploadControllerRef.current?.abort()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  const broadcastAndPersistSource = useCallback(
    (source: Omit<SourceInfo, "senderId">, videoTime = 0, playing = false) => {
      const shared = channel.sendSource(source)
      mySourceRef.current = shared
      const state = currentState({ source: shared, videoTime, playing })
      channel.sendState({
        source: shared,
        videoTime,
        playing,
        reason: "source",
      })
      queuePersistState(state)
      return shared
    },
    [channel, currentState, queuePersistState],
  )

  const handleUrl = useCallback(
    (input: string) => {
      const url = normalizeVideoUrl(input)
      if (!url) {
        setVideoError("Enter a valid http:// or https:// video URL.")
        return
      }

      uploadTokenRef.current += 1
      uploadControllerRef.current?.abort()
      uploadControllerRef.current = null
      setUploading(false)
      buffering.current = false
      setVideoError(null)
      setHint(null)
      setMyDuration(null)
      myDurationRef.current = null
      replaceSourceUrl(url)
      broadcastAndPersistSource({
        kind: "url",
        label: url,
        url,
        duration: null,
      })
    },
    [broadcastAndPersistSource, replaceSourceUrl],
  )

  const handleFile = useCallback(
    (file: File) => {
      uploadTokenRef.current += 1
      const token = uploadTokenRef.current
      uploadControllerRef.current?.abort()
      const controller = new AbortController()
      uploadControllerRef.current = controller

      buffering.current = false
      setVideoError(null)
      setHint("The video is available locally now and is being uploaded for your partner.")
      setMyDuration(null)
      myDurationRef.current = null
      setUploadProgress(0)
      setUploading(true)

      const objectUrl = URL.createObjectURL(file)
      replaceSourceUrl(objectUrl, objectUrl)
      const temporary = channel.sendSource({
        kind: "uploading",
        label: file.name,
        duration: null,
      })
      mySourceRef.current = temporary

      const previousStoragePath =
        latestStateRef.current?.source?.kind === "storage"
          ? latestStateRef.current.source.storagePath
          : undefined

      void uploadRoomVideo({
        roomId,
        file,
        signal: controller.signal,
        onProgress: (progress) => {
          if (uploadTokenRef.current === token) setUploadProgress(progress)
        },
      })
        .then(({ publicUrl, storagePath }) => {
          if (uploadTokenRef.current !== token) return
          uploadControllerRef.current = null
          setUploading(false)
          setUploadProgress(100)
          setHint("Upload complete. Your partner can now stream the same video.")

          const player = playerRef.current
          const shared = broadcastAndPersistSource(
            {
              kind: "storage",
              label: file.name,
              url: publicUrl,
              storagePath,
              duration: myDurationRef.current,
            },
            player?.getTime() ?? 0,
            Boolean(player && !player.isPaused()),
          )

          mySourceRef.current = shared
          if (previousStoragePath && previousStoragePath !== storagePath) {
            void removeStoredVideo(previousStoragePath).catch(() => undefined)
          }
        })
        .catch((error) => {
          if (uploadTokenRef.current !== token) return
          uploadControllerRef.current = null
          setUploading(false)
          if (error instanceof DOMException && error.name === "AbortError") {
            setHint("Upload cancelled. This local file is not available to your partner.")
            return
          }
          setVideoError(error instanceof Error ? error.message : "Could not upload this video.")
          setHint("The file still plays on this device, but it was not shared with your partner.")
        })
    },
    [broadcastAndPersistSource, channel, replaceSourceUrl, roomId],
  )

  const cancelUpload = useCallback(() => {
    uploadTokenRef.current += 1
    uploadControllerRef.current?.abort()
    uploadControllerRef.current = null
    setUploading(false)
    setHint("Upload cancelled. This local file is not available to your partner.")
  }, [])

  const guard = (fn: () => void) => {
    if (!isRemoteEventSuppressed()) fn()
  }

  const broadcastPlayerState = (action: "play" | "pause" | "seek" | "buffer" | "resume") => {
    const player = playerRef.current
    if (!player) return
    if (mySourceRef.current?.kind === "uploading") return
    channel.sendPlayer({ action, videoTime: player.getTime() })
    if (mySourceRef.current && action !== "buffer") {
      queuePersistState(currentState({ playing: action === "play" || action === "resume" }))
    }
  }

  const mismatch =
    myDuration != null &&
    partnerSource?.duration != null &&
    Math.abs(myDuration - partnerSource.duration) > 1.5

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setPersistenceError("Could not copy the room code. Select it manually.")
    }
  }

  if (channel.status === "full") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <Users className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">This room is full</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          A watch room fits two people. Ask your partner for a different code, or start your own room.
        </p>
        <Button onClick={() => router.push("/")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back home
        </Button>
      </div>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/")} aria-label="Leave room">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <p className="text-xs text-muted-foreground">Room code</p>
            <button
              onClick={copyCode}
              className="flex items-center gap-2 font-mono text-lg font-semibold tracking-widest text-foreground"
              aria-label={`Copy room code ${roomId}`}
            >
              {roomId}
              {copied ? (
                <Check className="h-4 w-4 text-primary" />
              ) : (
                <Copy className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </div>
        </div>

        <StatusPill
          status={channel.status}
          hasPartner={Boolean(channel.partner)}
          partnerName={channel.partner?.name}
        />
      </header>

      {mismatch && (
        <Banner tone="warning">
          The two video files have different durations. Make sure both participants use the same file.
        </Banner>
      )}
      {videoError && <Banner tone="error">{videoError}</Banner>}
      {persistenceError && <Banner tone="warning">{persistenceError}</Banner>}
      {channel.connectionError && <Banner tone="error">{channel.connectionError}</Banner>}
      {!channel.partner && channel.status === "connected" && (
        <Banner tone="info">
          Waiting for your partner — share room code <strong>{roomId}</strong>.
        </Banner>
      )}
      {channel.status === "reconnecting" && <Banner tone="info">Reconnecting…</Banner>}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <VideoPlayer
            ref={playerRef}
            src={src}
            onLoadedMetadata={(duration: number | null) => {
              setMyDuration(duration)
              myDurationRef.current = duration
              if (mySourceRef.current) {
                mySourceRef.current = { ...mySourceRef.current, duration }
              }

              const restore = pendingRestoreRef.current
              if (restore) restorePlayback(restore)

              const source = mySourceRef.current
              if (source && source.kind !== "uploading") {
                const shared = channel.sendSource({
                  ...source,
                  duration,
                })
                mySourceRef.current = shared
                queuePersistState(currentState({ source: shared }))
              }
            }}
            onError={(message: string) => setVideoError(message)}
            onPlay={() => guard(() => broadcastPlayerState("play"))}
            onPause={() =>
              guard(() => {
                if (!buffering.current) broadcastPlayerState("pause")
              })
            }
            onSeeked={() => guard(() => broadcastPlayerState("seek"))}
            onWaiting={() =>
              guard(() => {
                buffering.current = true
                broadcastPlayerState("buffer")
              })
            }
            onPlaying={() =>
              guard(() => {
                if (!buffering.current) return
                buffering.current = false
                broadcastPlayerState("resume")
              })
            }
          />
          <SourceControls
            onUrl={handleUrl}
            onFile={handleFile}
            onCancelUpload={cancelUpload}
            uploading={uploading}
            uploadProgress={uploadProgress}
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
              void persistRoomMessage(roomId, message)
                .then(() => setPersistenceError(null))
                .catch((error) => {
                  setPersistenceError(
                    error instanceof Error
                      ? `Message was sent live but not saved: ${error.message}`
                      : "Message was sent live but not saved.",
                  )
                })
            }}
          />
        </div>
      </div>
    </main>
  )
}

function StatusPill({
  status,
  hasPartner,
  partnerName,
}: {
  status: string
  hasPartner: boolean
  partnerName?: string
}) {
  const online = status === "connected" && hasPartner
  const label =
    status === "connecting"
      ? "Connecting…"
      : status === "reconnecting"
        ? "Reconnecting…"
        : status === "error"
          ? "Connection error"
          : online
            ? `${partnerName ?? "Partner"} connected`
            : "Waiting for partner"

  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
      <span
        className={`h-2 w-2 rounded-full ${online ? "bg-primary" : "bg-muted-foreground"}`}
        aria-hidden
      />
      <span className="text-card-foreground">{label}</span>
    </div>
  )
}

function Banner({
  tone,
  children,
}: {
  tone: "info" | "warning" | "error"
  children: React.ReactNode
}) {
  const toneClasses =
    tone === "error"
      ? "border-destructive/40 bg-destructive/10 text-foreground"
      : tone === "warning"
        ? "border-primary/40 bg-primary/10 text-foreground"
        : "border-border bg-card text-card-foreground"
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${toneClasses}`}>
      {tone !== "info" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <p className="text-pretty">{children}</p>
    </div>
  )
}
