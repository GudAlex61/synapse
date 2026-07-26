"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, Copy, Check, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VideoPlayer, type VideoPlayerHandle } from "@/components/video-player"
import { Chat } from "@/components/chat"
import { SourceControls } from "@/components/source-controls"
import { useRoomChannel } from "@/hooks/use-room-channel"
import type { ChatItem, SourceInfo } from "@/lib/sync-types"

// If our clock says playback should differ from the timekeeper by more than
// this many seconds, we hard-correct via seek.
const DRIFT_THRESHOLD = 1
const HEARTBEAT_MS = 4000
// After we programmatically drive the player, ignore its own events for this
// long so we don't rebroadcast (echo) the action back to our partner.
const ECHO_WINDOW_MS = 600

export function WatchRoom({ roomId, userName }: { roomId: string; userName: string }) {
  const router = useRouter()
  const playerRef = useRef<VideoPlayerHandle>(null)

  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [src, setSrc] = useState<string | null>(null)
  const [myDuration, setMyDuration] = useState<number | null>(null)
  const [partnerSource, setPartnerSource] = useState<SourceInfo | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const applyingRemote = useRef(false)
  const buffering = useRef(false)
  const mySourceRef = useRef<SourceInfo | null>(null)
  const srcRef = useRef<string | null>(null)
  srcRef.current = src

  const pushSystem = useCallback((text: string) => {
    setChatItems((prev) => [
      ...prev,
      { kind: "system", id: crypto.randomUUID(), text, at: Date.now() },
    ])
  }, [])

  // Run `fn` as a "remote-driven" action so our own player events are not
  // echoed back over the channel.
  const withRemote = useCallback((fn: () => void) => {
    applyingRemote.current = true
    fn()
    window.setTimeout(() => {
      applyingRemote.current = false
    }, ECHO_WINDOW_MS)
  }, [])

  const loadUrl = useCallback((url: string) => {
    setVideoError(null)
    setHint(null)
    setMyDuration(null)
    setSrc(url)
    mySourceRef.current = { kind: "url", label: url, url, duration: null, senderId: "" }
    return mySourceRef.current
  }, [])

  const loadFile = useCallback((file: File) => {
    setVideoError(null)
    setHint(null)
    setMyDuration(null)
    const objectUrl = URL.createObjectURL(file)
    setSrc(objectUrl)
    mySourceRef.current = { kind: "file", label: file.name, duration: null, senderId: "" }
    return mySourceRef.current
  }, [])

  // ---- Realtime channel ----------------------------------------------------
  const channel = useRoomChannel({
    roomId,
    userName,
    handlers: {
      onSystem: pushSystem,
      onChat: (e) => setChatItems((prev) => [...prev, { kind: "chat", ...e }]),
      onSource: (info) => {
        setPartnerSource(info)
        pushSystem(`Partner loaded "${info.label}"`)
        if (!srcRef.current && info.kind === "url" && info.url) {
          loadUrl(info.url)
        } else if (!srcRef.current && info.kind === "file") {
          setHint(`Partner is watching "${info.label}". Choose the same file to sync.`)
        }
      },
      onPlayer: (e) => {
        const player = playerRef.current
        if (!player) return
        const delay = (Date.now() - e.at) / 1000
        switch (e.action) {
          case "play":
          case "resume":
            withRemote(() => {
              player.seek(e.videoTime + Math.max(0, delay))
              void player.play()
            })
            break
          case "pause":
            withRemote(() => {
              player.seek(e.videoTime)
              player.pause()
            })
            break
          case "buffer":
            // Partner is buffering — hold here until they resume.
            withRemote(() => player.pause())
            break
          case "seek":
            withRemote(() => player.seek(e.videoTime + Math.max(0, delay)))
            break
        }
      },
      onStateRequest: (fromId) => {
        // Someone joined and asked for the current state. Only respond if we
        // actually have a video loaded.
        const player = playerRef.current
        if (!srcRef.current || !player) return
        channel.sendState({
          source: mySourceRef.current,
          videoTime: player.getTime(),
          playing: !player.isPaused(),
          reason: "join",
          toId: fromId,
        })
      },
      onStateResponse: (res) => {
        setPartnerSource(res.source)
        const player = playerRef.current

        if (res.reason === "join") {
          if (res.toId !== channel.myId) return
          // Full resync to the existing member.
          if (!srcRef.current && res.source) {
            if (res.source.kind === "url" && res.source.url) loadUrl(res.source.url)
            else if (res.source.kind === "file") {
              setHint(`Partner is watching "${res.source.label}". Choose the same file to sync.`)
            }
          }
          if (player && srcRef.current) {
            const expected = res.videoTime + (res.playing ? (Date.now() - res.at) / 1000 : 0)
            withRemote(() => {
              player.seek(expected)
              if (res.playing) void player.play()
              else player.pause()
            })
          }
          return
        }

        // reason === "heartbeat": only the follower corrects drift.
        if (!player || !srcRef.current) return
        if (channel.myId === timekeeperIdRef.current) return
        const expected = res.videoTime + (res.playing ? (Date.now() - res.at) / 1000 : 0)
        const mine = player.getTime()
        if (Math.abs(expected - mine) > DRIFT_THRESHOLD) {
          withRemote(() => player.seek(expected))
        }
        if (res.playing && player.isPaused()) withRemote(() => void player.play())
        if (!res.playing && !player.isPaused()) withRemote(() => player.pause())
      },
    },
  })

  // Deterministic timekeeper: the participant with the smaller id owns the
  // heartbeat; the other one follows and corrects drift.
  const timekeeperId = useMemo(() => {
    if (!channel.partner) return channel.myId
    return [channel.myId, channel.partner.id].sort()[0]
  }, [channel.myId, channel.partner])
  const timekeeperIdRef = useRef(timekeeperId)
  timekeeperIdRef.current = timekeeperId

  // Heartbeat: timekeeper broadcasts its position periodically.
  useEffect(() => {
    if (!channel.partner) return
    const interval = window.setInterval(() => {
      const player = playerRef.current
      if (!player || !srcRef.current) return
      if (channel.myId !== timekeeperIdRef.current) return
      channel.sendState({
        source: mySourceRef.current,
        videoTime: player.getTime(),
        playing: !player.isPaused(),
        reason: "heartbeat",
      })
    }, HEARTBEAT_MS)
    return () => window.clearInterval(interval)
  }, [channel])

  // ---- Local player event handlers ----------------------------------------
  const guard = (fn: () => void) => {
    if (applyingRemote.current) return
    fn()
  }

  const broadcastSource = useCallback(
    (info: SourceInfo, duration: number | null) => {
      channel.sendSource({ ...info, duration })
    },
    [channel],
  )

  const onUrl = (url: string) => {
    const info = loadUrl(url)
    broadcastSource(info, null)
  }
  const onFile = (file: File) => {
    const info = loadFile(file)
    broadcastSource(info, null)
  }

  // ---- Derived UI state ----------------------------------------------------
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
      /* clipboard unavailable */
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
      {/* Header */}
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
          hasPartner={!!channel.partner}
          partnerName={channel.partner?.name}
        />
      </header>

      {/* Banners */}
      {mismatch && (
        <Banner tone="warning">
          The two video files look different (durations don&apos;t match), so playback may drift.
          Make sure you both loaded the same file.
        </Banner>
      )}
      {videoError && <Banner tone="error">{videoError}</Banner>}
      {!channel.partner && channel.status !== "connecting" && (
        <Banner tone="info">
          Waiting for your partner to join — share the room code <strong>{roomId}</strong> with them.
        </Banner>
      )}
      {channel.status === "reconnecting" && (
        <Banner tone="info">Reconnecting…</Banner>
      )}

      {/* Content */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <VideoPlayer
            ref={playerRef}
            src={src}
            onLoadedMetadata={(duration) => {
              setMyDuration(duration)
              if (mySourceRef.current) {
                mySourceRef.current = { ...mySourceRef.current, duration }
                broadcastSource(mySourceRef.current, duration)
              }
            }}
            onError={(msg) => setVideoError(msg)}
            onPlay={() =>
              guard(() =>
                channel.sendPlayer({ action: "play", videoTime: playerRef.current?.getTime() ?? 0 }),
              )
            }
            onPause={() =>
              guard(() => {
                if (buffering.current) return
                channel.sendPlayer({ action: "pause", videoTime: playerRef.current?.getTime() ?? 0 })
              })
            }
            onSeeked={() =>
              guard(() =>
                channel.sendPlayer({ action: "seek", videoTime: playerRef.current?.getTime() ?? 0 }),
              )
            }
            onWaiting={() =>
              guard(() => {
                buffering.current = true
                channel.sendPlayer({ action: "buffer", videoTime: playerRef.current?.getTime() ?? 0 })
              })
            }
            onPlaying={() =>
              guard(() => {
                if (!buffering.current) return
                buffering.current = false
                // Finished buffering — tell partner to resume from here.
                channel.sendPlayer({ action: "resume", videoTime: playerRef.current?.getTime() ?? 0 })
              })
            }
          />
          <SourceControls onUrl={onUrl} onFile={onFile} hint={hint} />
        </div>

        <div className="h-[420px] lg:h-auto">
          <Chat
            items={chatItems}
            myId={channel.myId}
            onSend={(text) => {
              const msg = channel.sendChat(text)
              setChatItems((prev) => [...prev, { kind: "chat", ...msg }])
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
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
      <span
        className={`h-2 w-2 rounded-full ${online ? "bg-primary" : "bg-muted-foreground"}`}
        aria-hidden
      />
      <span className="text-card-foreground">
        {online ? `${partnerName ?? "Partner"} connected` : "Waiting for partner"}
      </span>
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
