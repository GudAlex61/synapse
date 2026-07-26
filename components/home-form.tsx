"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "@/lib/room"

const NAME_KEY = "watch-together:name"

export function HomeForm() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saved = window.localStorage.getItem(NAME_KEY)
    if (saved) setName(saved)
  }, [])

  const enter = (roomId: string) => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Enter a display name first.")
      return
    }
    window.localStorage.setItem(NAME_KEY, trimmed)
    router.push(`/room/${roomId}?name=${encodeURIComponent(trimmed)}`)
  }

  const handleCreate = () => {
    setError(null)
    enter(generateRoomCode())
  }

  const handleJoin = () => {
    setError(null)
    const clean = normalizeRoomCode(code)
    if (!isValidRoomCode(clean)) {
      setError("Room codes are 6 letters/numbers.")
      return
    }
    enter(clean)
  }

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="name" className="text-sm font-medium text-card-foreground">
          Your name
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          maxLength={24}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
      </div>

      <Button size="lg" onClick={handleCreate}>
        Create a room
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-wider text-muted-foreground">or join</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="code" className="text-sm font-medium text-card-foreground">
          Room code
        </label>
        <div className="flex gap-2">
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoin()
            }}
            placeholder="ABC123"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm uppercase tracking-widest text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
          <Button variant="secondary" onClick={handleJoin}>
            Join
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
