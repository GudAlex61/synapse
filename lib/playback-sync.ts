import type { LogicalRevision, PersistedRoomState, PlayerEvent } from "./sync-types"

export const ZERO_REVISION: LogicalRevision = { counter: 0, senderId: "" }

export function normalizeRevision(value: unknown): LogicalRevision {
  if (!value || typeof value !== "object") return ZERO_REVISION
  const record = value as Record<string, unknown>
  const counter =
    typeof record.counter === "number" && Number.isSafeInteger(record.counter) && record.counter >= 0
      ? record.counter
      : 0
  const senderId = typeof record.senderId === "string" ? record.senderId.slice(0, 100) : ""
  return { counter, senderId }
}

export function compareRevisions(a: LogicalRevision, b: LogicalRevision): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
  return a.senderId.localeCompare(b.senderId)
}

export function nextRevision(
  senderId: string,
  localCounter: number,
  lastApplied: LogicalRevision,
): LogicalRevision {
  return {
    counter: Math.max(localCounter, lastApplied.counter) + 1,
    senderId,
  }
}

export function shouldApplyRevision(
  incoming: LogicalRevision,
  applied: LogicalRevision,
  allowEqual = false,
): boolean {
  const comparison = compareRevisions(incoming, applied)
  return comparison > 0 || (allowEqual && comparison === 0)
}

export function chooseNewestState(
  a: PersistedRoomState | null,
  b: PersistedRoomState | null,
): PersistedRoomState | null {
  if (!a) return b
  if (!b) return a
  const revisionOrder = compareRevisions(a.revision, b.revision)
  if (revisionOrder !== 0) return revisionOrder > 0 ? a : b
  return a.updatedAt >= b.updatedAt ? a : b
}

export function clampVideoTime(value: number, duration?: number | null): number {
  if (!Number.isFinite(value)) return 0
  const max = duration != null && Number.isFinite(duration) && duration >= 0 ? duration : Infinity
  return Math.max(0, Math.min(value, max))
}

export interface PlaybackSnapshot {
  sourceId: string
  videoTime: number
  playing: boolean
  revision: LogicalRevision
}

export function applyPlayerEventToSnapshot(
  current: PlaybackSnapshot,
  event: PlayerEvent,
): PlaybackSnapshot {
  if (event.sourceId !== current.sourceId) return current
  if (!shouldApplyRevision(event.revision, current.revision)) return current
  return {
    sourceId: current.sourceId,
    videoTime: clampVideoTime(event.videoTime),
    playing: event.playing,
    revision: event.revision,
  }
}
