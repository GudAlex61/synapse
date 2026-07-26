"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import Hls from "hls.js"
import { Play } from "lucide-react"

export interface VideoPlayerHandle {
  play: () => Promise<void>
  pause: () => void
  seek: (t: number) => void
  getTime: () => number
  getDuration: () => number
  isPaused: () => boolean
}

interface VideoPlayerProps {
  src: string | null
  onPlay?: () => void
  onPause?: () => void
  onSeeked?: () => void
  onWaiting?: () => void
  onPlaying?: () => void
  onLoadedMetadata?: (duration: number) => void
  onError?: (message: string) => void
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer(props, ref) {
    const {
      src,
      onPlay,
      onPause,
      onSeeked,
      onWaiting,
      onPlaying,
      onLoadedMetadata,
      onError,
    } = props
    const videoRef = useRef<HTMLVideoElement>(null)
    const [needsGesture, setNeedsGesture] = useState(true)

    useImperativeHandle(ref, () => ({
      play: async () => {
        try {
          await videoRef.current?.play()
        } catch {
          // Autoplay blocked (iOS) — surface the gesture overlay.
          setNeedsGesture(true)
        }
      },
      pause: () => videoRef.current?.pause(),
      seek: (t: number) => {
        if (videoRef.current) videoRef.current.currentTime = t
      },
      getTime: () => videoRef.current?.currentTime ?? 0,
      getDuration: () => videoRef.current?.duration ?? 0,
      isPaused: () => videoRef.current?.paused ?? true,
    }))

    // Load the source, using hls.js for m3u8 where the browser lacks native HLS.
    useEffect(() => {
      const video = videoRef.current
      if (!video || !src) return

      const isHls = /\.m3u8($|\?)/i.test(src)
      let hls: Hls | null = null

      if (isHls && !video.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
        hls = new Hls({ enableWorker: true })
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) onError?.("Could not load this HLS stream.")
        })
      } else {
        video.src = src
      }

      return () => {
        if (hls) hls.destroy()
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src])

    const handleGesture = async () => {
      setNeedsGesture(false)
      try {
        await videoRef.current?.play()
      } catch {
        /* user can use controls */
      }
    }

    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          className="h-full w-full"
          controls
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          onPlay={onPlay}
          onPause={onPause}
          onSeeked={onSeeked}
          onWaiting={onWaiting}
          onPlaying={onPlaying}
          onLoadedMetadata={(e) => onLoadedMetadata?.(e.currentTarget.duration)}
          onError={() => {
            if (src) onError?.("Could not load this video source.")
          }}
        />

        {src && needsGesture && (
          <button
            type="button"
            onClick={handleGesture}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-foreground backdrop-blur-sm transition hover:bg-black/60"
            aria-label="Tap to start watching"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />
            </span>
            <span className="text-sm font-medium">Tap to start watching</span>
          </button>
        )}

        {!src && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No video loaded yet. Paste a direct video link or choose a local file to begin.
          </div>
        )}
      </div>
    )
  },
)
