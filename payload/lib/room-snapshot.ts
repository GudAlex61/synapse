import { chooseNewestState, normalizeRevision } from "./playback-sync.ts"
import type { ChatEvent, PersistedRoomState, RoomSnapshot, SourceInfo } from "./sync-types"

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
  if (kind !== "url" && kind !== "p2p") return null
  if (
    typeof value.sourceId !== "string" ||
    value.sourceId.length === 0 ||
    value.sourceId.length > 200 ||
    typeof value.label !== "string"
  ) {
    return null
  }

  const source: SourceInfo = {
    kind,
    sourceId: value.sourceId,
    revision: normalizeRevision(value.revision),
    label: value.label.slice(0, 500),
    duration:
      typeof value.duration === "number" && Number.isFinite(value.duration)
        ? Math.max(0, value.duration)
        : null,
    senderId: typeof value.senderId === "string" ? value.senderId.slice(0, 100) : "",
  }

  if (kind === "url") {
    if (typeof value.url !== "string" || value.url.length > 4000) return null
    try {
      const url = new URL(value.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") return null
      source.url = value.url
    } catch {
      return null
    }
  }

  if (kind === "p2p") {
    if (
      typeof value.ownerId !== "string" ||
      value.ownerId.length < 1 ||
      value.ownerId.length > 100 ||
      typeof value.streamSessionId !== "string" ||
      value.streamSessionId.length < 1 ||
      value.streamSessionId.length > 100
    ) {
      return null
    }
    source.ownerId = value.ownerId
    source.streamSessionId = value.streamSessionId
    if (typeof value.mimeType === "string") source.mimeType = value.mimeType.slice(0, 200)
    if (typeof value.lastModified === "number" && Number.isFinite(value.lastModified)) {
      source.lastModified = Math.max(0, value.lastModified)
    }
  }

  if (typeof value.fileSize === "number" && Number.isFinite(value.fileSize) && value.fileSize >= 0) {
    source.fileSize = value.fileSize
  }
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
      revision: normalizeRevision(value.state.revision),
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
  return {
    state: chooseNewestState(a.state, b.state),
    messages: dedupeMessages([...a.messages, ...b.messages]).slice(-MAX_ROOM_MESSAGES),
  }
}
