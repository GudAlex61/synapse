"use client"

import { useRef, useState } from "react"
import { LinkIcon, Radio, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { P2PQualityPreset } from "@/lib/sync-types"

interface SourceControlsProps {
  onUrl: (url: string) => void
  onFile: (file: File, handle?: FileSystemFileHandle) => void
  onRestore?: () => void
  canRestore?: boolean
  hint?: string | null
  disabled?: boolean
  qualityPreset?: P2PQualityPreset
  onQualityPresetChange?: (preset: P2PQualityPreset) => void
  showQuality?: boolean
}

interface WindowWithPicker extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    excludeAcceptAllOption?: boolean
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<FileSystemFileHandle[]>
}

export function SourceControls({
  onUrl,
  onFile,
  onRestore,
  canRestore = false,
  hint,
  disabled = false,
  qualityPreset = "auto",
  onQualityPresetChange,
  showQuality = false,
}: SourceControlsProps) {
  const [url, setUrl] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const submitUrl = () => {
    const value = url.trim()
    if (value && !disabled) onUrl(value)
  }

  const chooseFile = async () => {
    if (disabled) return
    const picker = (window as WindowWithPicker).showOpenFilePicker
    if (!picker) {
      fileRef.current?.click()
      return
    }
    try {
      const [handle] = await picker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: "Видео",
            accept: {
              "video/*": [".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv"],
            },
          },
        ],
      })
      if (!handle) return
      onFile(await handle.getFile(), handle)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      fileRef.current?.click()
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitUrl()
            }}
            placeholder="Прямая .mp4, .webm или .m3u8 ссылка"
            disabled={disabled}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Ссылка на видео"
          />
          <Button variant="secondary" onClick={submitUrl} disabled={!url.trim() || disabled}>
            Открыть
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="video/*,.m4v,.mkv,.mov,.ogv"
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onFile(file)
            event.target.value = ""
          }}
        />
        <Button variant="outline" className="w-full sm:w-auto" disabled={disabled} onClick={chooseFile}>
          <Radio className="mr-2 h-4 w-4" />
          Выбрать и транслировать
        </Button>
        {canRestore && (
          <Button variant="outline" className="w-full sm:w-auto" onClick={onRestore} disabled={disabled}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Восстановить файл
          </Button>
        )}
      </div>

      {showQuality && (
        <label className="mt-3 flex flex-col gap-1.5 text-sm text-card-foreground sm:max-w-xs">
          <span className="font-medium">Качество P2P-трансляции</span>
          <select
            value={qualityPreset}
            onChange={(event) => onQualityPresetChange?.(event.target.value as P2PQualityPreset)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="auto">Авто — адаптивное до 1080p</option>
            <option value="high">Высокое — приоритет детализации</option>
            <option value="balanced">Стабильное — 720p / 30 FPS</option>
            <option value="saver">Экономное — 540p / 24 FPS</option>
          </select>
        </label>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Файл не загружается целиком: браузер передаёт только живой WebRTC-поток. Поэтому фильм размером 2 ГБ требует примерно ту же скорость сети, что и серия 500 МБ; важны разрешение, FPS и выбранный профиль качества.
      </p>
      {hint && <p className="mt-3 text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
