"use client"

import { useRef, useState } from "react"
import { LinkIcon, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface SourceControlsProps {
  onUrl: (url: string) => void
  onFile: (file: File) => void
  onCancelUpload?: () => void
  hint?: string | null
  uploading?: boolean
  uploadProgress?: number
}

export function SourceControls({
  onUrl,
  onFile,
  onCancelUpload,
  hint,
  uploading = false,
  uploadProgress = 0,
}: SourceControlsProps) {
  const [url, setUrl] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const submitUrl = () => {
    const value = url.trim()
    if (value && !uploading) onUrl(value)
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitUrl()
            }}
            placeholder="Paste a direct .mp4 or .m3u8 link"
            disabled={uploading}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Video URL"
          />
          <Button
            variant="secondary"
            onClick={submitUrl}
            disabled={!url.trim() || uploading}
          >
            Load
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.m3u8"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onFile(file)
              e.target.value = ""
            }}
          />
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Choose file
          </Button>
          {uploading && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onCancelUpload}
              aria-label="Cancel upload"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {uploading && (
        <div className="mt-3" aria-live="polite">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>Uploading video for your partner…</span>
            <span>{Math.round(uploadProgress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.min(100, Math.max(0, uploadProgress))}%` }}
            />
          </div>
        </div>
      )}

      {hint && <p className="mt-3 text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
