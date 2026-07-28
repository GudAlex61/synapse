import type {
  ChatEvent,
  PersistedRoomState,
  RoomSnapshot,
  SourceInfo,
} from "./sync-types"

export const MAX_ROOM_MESSAGES = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function parseSource(value: unknown): SourceInfo | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  if (kind !== "url" && kind !== "storage" && kind !== "uploading") return null
  if (typeof value.label !== "string") return null

  const source: SourceInfo = {
    kind,
    label: value.label.slice(0, 500),
    duration:
      typeof value.duration === "number" && Number.isFinite(value.duration)
        ? value.duration
        : null,
    senderId: typeof value.senderId === "string" ? value.senderId : "",
  }

  if (typeof value.url === "string") {
    try {
      const url = new URL(value.url)
      if ((url.protocol !== "http:" && url.protocol !== "https:") || value.url.length > 4000) {
        return null
      }
      source.url = value.url
    } catch {
      return null
    }
  }
  if ((kind === "url" || kind === "storage") && !source.url) return null
  if (typeof value.storagePath === "string") source.storagePath = value.storagePath.slice(0, 1000)
  return source
}

function parseMessage(value: unknown): ChatEvent | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== "string" ||
    typeof value.senderId !== "string" ||
    typeof value.senderName !== "string" ||
    typeof value.text !== "string"
  ) {
    return null
  }

  return {
    id: value.id,
    senderId: value.senderId,
    senderName: value.senderName.slice(0, 24),
    text: value.text.slice(0, 500),
    at: asFiniteNumber(value.at, Date.now()),
  }
}

export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  if (!isRecord(value)) return { state: null, messages: [] }

  let state: PersistedRoomState | null = null
  if (isRecord(value.state)) {
    state = {
      source: parseSource(value.state.source),
      videoTime: Math.max(0, asFiniteNumber(value.state.videoTime)),
      playing: value.state.playing === true,
      updatedAt: asFiniteNumber(value.state.updatedAt),
      updatedBy: typeof value.state.updatedBy === "string" ? value.state.updatedBy : "",
    }
  }

  const messages = Array.isArray(value.messages)
    ? value.messages.map(parseMessage).filter((item): item is ChatEvent => item !== null)
    : []

  return { state, messages: dedupeMessages(messages).slice(-MAX_ROOM_MESSAGES) }
}

export function dedupeMessages(messages: ChatEvent[]): ChatEvent[] {
  const byId = new Map<string, ChatEvent>()
  for (const message of messages) {
    const current = byId.get(message.id)
    if (!current || message.at >= current.at) byId.set(message.id, message)
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

export function mergeSnapshots(a: RoomSnapshot, b: RoomSnapshot): RoomSnapshot {
  const aUpdated = a.state?.updatedAt ?? 0
  const bUpdated = b.state?.updatedAt ?? 0
  return {
    state: bUpdated >= aUpdated ? b.state : a.state,
    messages: dedupeMessages([...a.messages, ...b.messages]).slice(-MAX_ROOM_MESSAGES),
  }
}
