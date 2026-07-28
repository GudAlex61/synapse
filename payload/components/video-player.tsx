"use client"

import Hls from "hls.js"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Play, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"

interface CapturableVideoElement extends HTMLVideoElement {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

export interface VideoPlayerHandle {
  play: (silent?: boolean) => Promise<boolean>
  pause: (silent?: boolean) => void
  seek: (time: number, silent?: boolean) => void
  applyState: (time: number, playing: boolean) => Promise<boolean>
  getTime: () => number
  getDuration: () => number
  isPaused: () => boolean
  isReady: () => boolean
  getCaptureStream: () => Promise<MediaStream | null>
}

interface VideoPlayerProps {
  src?: string | null
  stream?: MediaStream | null
  readOnly?: boolean
  emptyText?: string
  onPlay?: () => void
  onPause?: () => void
  onSeeked?: () => void
  onLoadedMetadata?: (duration: number | null) => void
  onError?: (message: string) => void
}

interface PendingSeek {
  target: number
  expiresAt: number
}

function clampVideoTime(value: number, duration: number | null): number {
  if (!Number.isFinite(value)) return 0
  const nonNegative = Math.max(0, value)
  return duration && Number.isFinite(duration) ? Math.min(nonNegative, duration) : nonNegative
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  {
    src = null,
    stream = null,
    readOnly = false,
    emptyText = "Видео не выбрано.",
    onPlay,
    onPause,
    onSeeked,
    onLoadedMetadata,
    onError,
  },
  ref,
) {
  const videoRef = useRef<CapturableVideoElement>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const suppressPlayUntilRef = useRef(0)
  const suppressPauseUntilRef = useRef(0)
  const pendingSeekRef = useRef<PendingSeek | null>(null)
  const captureRef = useRef<MediaStream | null>(null)
  const fallbackCleanupRef = useRef<(() => void) | null>(null)
  const capturePulseRef = useRef(0)
  const [needsGesture, setNeedsGesture] = useState(false)
  const [remoteMuted, setRemoteMuted] = useState(false)

  const play = async (silent = false): Promise<boolean> => {
    const video = videoRef.current
    if (!video) return false
    if (!video.paused) return true
    if (silent) suppressPlayUntilRef.current = Date.now() + 2_000
    try {
      await video.play()
      setNeedsGesture(false)
      return true
    } catch {
      if (silent) suppressPlayUntilRef.current = 0
      setNeedsGesture(true)
      return false
    }
  }

  const pause = (silent = false) => {
    const video = videoRef.current
    if (!video || video.paused) return
    if (silent) suppressPauseUntilRef.current = Date.now() + 2_000
    video.pause()
  }

  const seek = (time: number, silent = false) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(time) || stream) return
    const target = clampVideoTime(time, Number.isFinite(video.duration) ? video.duration : null)
    if (Math.abs(video.currentTime - target) < 0.04) return
    if (silent) pendingSeekRef.current = { target, expiresAt: Date.now() + 8_000 }
    try {
      video.currentTime = target
    } catch {
      // Retried after loadedmetadata by the room controller.
    }
  }

  const stopCapture = () => {
    fallbackCleanupRef.current?.()
    fallbackCleanupRef.current = null
    captureRef.current?.getTracks().forEach((track) => track.stop())
    captureRef.current = null
  }

  const createFallbackCapture = async (video: HTMLVideoElement): Promise<MediaStream | null> => {
    if (!("captureStream" in HTMLCanvasElement.prototype)) return null
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(2, video.videoWidth || 1280)
    canvas.height = Math.max(2, video.videoHeight || 720)
    const context = canvas.getContext("2d", { alpha: false })
    if (!context) return null
    const canvasStream = canvas.captureStream(30)
    let stopped = false
    let frameRequest = 0

    const draw = () => {
      if (stopped) return
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
      } catch {
        // The next frame can recover.
      }
      const callback = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number
      }).requestVideoFrameCallback
      if (callback) frameRequest = callback.call(video, draw)
      else frameRequest = window.requestAnimationFrame(draw)
    }
    draw()

    let audioContext: AudioContext | null = null
    try {
      const AudioContextCtor = window.AudioContext
      if (AudioContextCtor) {
        audioContext = new AudioContextCtor()
        const sourceNode = audioContext.createMediaElementSource(video)
        const destination = audioContext.createMediaStreamDestination()
        sourceNode.connect(destination)
        sourceNode.connect(audioContext.destination)
        await audioContext.resume().catch(() => undefined)
        for (const track of destination.stream.getAudioTracks()) canvasStream.addTrack(track)
      }
    } catch {
      // Video-only fallback remains useful.
    }

    fallbackCleanupRef.current = () => {
      stopped = true
      const cancelVideoFrame = (video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void
      }).cancelVideoFrameCallback
      if (cancelVideoFrame && frameRequest) cancelVideoFrame.call(video, frameRequest)
      else if (frameRequest) window.cancelAnimationFrame(frameRequest)
      canvasStream.getTracks().forEach((track) => track.stop())
      void audioContext?.close()
    }
    return canvasStream
  }

  const publishPausedCaptureFrame = (video: CapturableVideoElement) => {
    if (!captureRef.current || !video.paused || video.ended || stream) return
    const pulseId = capturePulseRef.current + 1
    capturePulseRef.current = pulseId
    suppressPlayUntilRef.current = Date.now() + 2_000
    suppressPauseUntilRef.current = Date.now() + 2_000
    void video.play().then(() => {
      const finish = () => {
        if (capturePulseRef.current !== pulseId || video.paused) return
        video.pause()
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => finish())
      else window.setTimeout(finish, 80)
    }).catch(() => {
      suppressPlayUntilRef.current = 0
      suppressPauseUntilRef.current = 0
    })
  }

  const getCaptureStream = async (): Promise<MediaStream | null> => {
    const video = videoRef.current
    if (!video || stream || !src || video.readyState < 1) return null
    const existing = captureRef.current
    if (existing?.getTracks().some((track) => track.readyState === "live")) return existing
    stopCapture()

    let captured: MediaStream | null = null
    try {
      const capture = video.captureStream ?? video.mozCaptureStream
      if (capture) captured = capture.call(video)
    } catch {
      captured = null
    }
    if (!captured || captured.getTracks().length === 0) captured = await createFallbackCapture(video)
    if (!captured) return null
    for (const track of captured.getVideoTracks()) track.contentHint = "motion"
    for (const track of captured.getAudioTracks()) track.contentHint = "music"
    captureRef.current = captured
    return captured
  }

  useImperativeHandle(ref, () => ({
    play,
    pause,
    seek,
    applyState: async (time: number, playing: boolean) => {
      seek(time, true)
      if (playing) return play(true)
      pause(true)
      return true
    },
    getTime: () => videoRef.current?.currentTime ?? 0,
    getDuration: () => videoRef.current?.duration ?? 0,
    isPaused: () => videoRef.current?.paused ?? true,
    isReady: () => Boolean(videoRef.current && videoRef.current.readyState >= 1),
    getCaptureStream,
  }))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setNeedsGesture(false)
    pendingSeekRef.current = null
    stopCapture()
    let hls: Hls | null = null

    if (!video.paused) {
      suppressPauseUntilRef.current = Date.now() + 2_000
      video.pause()
    }
    video.srcObject = null

    if (stream) {
      video.srcObject = stream
      video.muted = remoteMuted
      void video.play().catch(() => setNeedsGesture(true))
      return () => {
        video.pause()
        video.srcObject = null
      }
    }

    if (!src) {
      video.removeAttribute("src")
      video.load()
      return
    }

    const isHls = /\.m3u8($|\?)/i.test(src)
    if (isHls && !video.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 30 })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError()
        else onErrorRef.current?.("Не удалось загрузить HLS-поток.")
      })
    } else {
      video.src = src
      video.load()
    }

    return () => {
      hls?.destroy()
      stopCapture()
      if (!video.paused) video.pause()
      video.removeAttribute("src")
      video.load()
    }
  }, [src, stream])

  useEffect(() => {
    const video = videoRef.current
    if (video && stream) video.muted = remoteMuted
  }, [remoteMuted, stream])

  useEffect(() => () => stopCapture(), [])

  const handleGesture = async () => {
    const started = await play(false)
    if (started) setNeedsGesture(false)
  }

  const hasMedia = Boolean(src || stream)

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        className="h-full w-full"
        controls={hasMedia && !readOnly}
        playsInline
        preload="metadata"
        onPlay={() => {
          setNeedsGesture(false)
          if (Date.now() <= suppressPlayUntilRef.current) {
            suppressPlayUntilRef.current = 0
            return
          }
          if (!readOnly) onPlay?.()
        }}
        onPause={() => {
          if (Date.now() <= suppressPauseUntilRef.current) {
            suppressPauseUntilRef.current = 0
            return
          }
          if (!readOnly) onPause?.()
        }}
        onSeeked={(event) => {
          const pending = pendingSeekRef.current
          if (pending) {
            const reached = Math.abs(event.currentTarget.currentTime - pending.target) < 0.75
            pendingSeekRef.current = null
            if (Date.now() <= pending.expiresAt && reached) return
          }
          if (!readOnly) {
            publishPausedCaptureFrame(event.currentTarget)
            onSeeked?.()
          }
        }}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration
          onLoadedMetadata?.(Number.isFinite(duration) ? duration : null)
        }}
        onError={() => {
          if (src) onError?.("Не удалось открыть видео. Проверьте формат или прямую ссылку.")
        }}
      />

      {stream && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => setRemoteMuted((value) => !value)}
          className="absolute bottom-3 right-3"
          aria-label={remoteMuted ? "Включить звук" : "Выключить звук"}
        >
          {remoteMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
      )}

      {hasMedia && needsGesture && (
        <button
          type="button"
          onClick={handleGesture}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-foreground backdrop-blur-sm transition hover:bg-black/60"
          aria-label="Начать просмотр"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />
          </span>
          <span className="text-sm font-medium">Нажмите, чтобы начать просмотр</span>
        </button>
      )}

      {!hasMedia && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      )}
    </div>
  )
})
