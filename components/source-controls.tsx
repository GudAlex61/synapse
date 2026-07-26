"use client"

import { useRef, useState } from "react"
import { LinkIcon, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"

interface SourceControlsProps {
  onUrl: (url: string) => void
  onFile: (file: File) => void
  hint?: string | null
}

export function SourceControls({ onUrl, onFile, hint }: SourceControlsProps) {
  const [url, setUrl] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim()) onUrl(url.trim())
            }}
            placeholder="Paste a direct .mp4 or .m3u8 link"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            aria-label="Video URL"
          />
          <Button
            variant="secondary"
            onClick={() => url.trim() && onUrl(url.trim())}
            disabled={!url.trim()}
          >
            Load
          </Button>
        </div>

        <div className="flex items-center">
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.m3u8"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onFile(file)
              e.target.value = ""
            }}
          />
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Choose file
          </Button>
        </div>
      </div>

      {hint && <p className="mt-3 text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
