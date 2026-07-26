"use client"

import { useEffect, useState } from "react"
import { Clapperboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WatchRoom } from "@/components/watch-room"

const NAME_KEY = "watch-together:name"

export function RoomGate({
  roomId,
  initialName,
}: {
  roomId: string
  initialName: string
}) {
  const [name, setName] = useState<string | null>(initialName || null)
  const [draft, setDraft] = useState("")

  useEffect(() => {
    if (name) {
      window.localStorage.setItem(NAME_KEY, name)
      return
    }
    const saved = window.localStorage.getItem(NAME_KEY)
    if (saved) setName(saved)
  }, [name])

  if (!name) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Clapperboard className="h-6 w-6" />
          </span>
          <h1 className="text-lg font-semibold text-card-foreground">
            Joining room {roomId}
          </h1>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Pick a display name so your partner knows who&apos;s watching.
          </p>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) setName(draft.trim())
            }}
            placeholder="Your name"
            maxLength={24}
            className="mb-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
          <Button className="w-full" onClick={() => draft.trim() && setName(draft.trim())}>
            Enter room
          </Button>
        </div>
      </main>
    )
  }

  return <WatchRoom roomId={roomId} userName={name} />
}
