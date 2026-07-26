"use client"

import { useEffect, useRef, useState } from "react"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChatItem } from "@/lib/sync-types"
import { cn } from "@/lib/utils"

interface ChatProps {
  items: ChatItem[]
  myId: string
  onSend: (text: string) => void
}

export function Chat({ items, myId, onSend }: ChatProps) {
  const [value, setValue] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  const submit = () => {
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue("")
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-card-foreground">Chat</h2>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        {items.length === 0 && (
          <p className="text-center text-xs text-muted-foreground">
            Say something to your watch partner.
          </p>
        )}

        {items.map((item) => {
          if (item.kind === "system") {
            return (
              <p
                key={item.id}
                className="text-center text-xs italic text-muted-foreground"
              >
                {item.text}
              </p>
            )
          }
          const mine = item.senderId === myId
          return (
            <div
              key={item.id}
              className={cn("flex flex-col", mine ? "items-end" : "items-start")}
            >
              {!mine && (
                <span className="mb-0.5 px-1 text-xs text-muted-foreground">
                  {item.senderName}
                </span>
              )}
              <span
                className={cn(
                  "max-w-[85%] break-words rounded-2xl px-3 py-2 text-sm",
                  mine
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm bg-secondary text-secondary-foreground",
                )}
              >
                {item.text}
              </span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Type a message…"
          maxLength={500}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          aria-label="Chat message"
        />
        <Button size="icon" onClick={submit} aria-label="Send message">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
