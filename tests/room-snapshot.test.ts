import test from "node:test"
import assert from "node:assert/strict"
import {
  dedupeMessages,
  mergeSnapshots,
  parseRoomSnapshot,
} from "../lib/room-snapshot.ts"
import type { ChatEvent, RoomSnapshot } from "../lib/sync-types.ts"

const first: ChatEvent = {
  id: "a",
  senderId: "one",
  senderName: "Alex",
  text: "first",
  at: 10,
}

const replacement: ChatEvent = { ...first, text: "replacement", at: 20 }
const second: ChatEvent = {
  id: "b",
  senderId: "two",
  senderName: "Sam",
  text: "second",
  at: 15,
}

test("chat messages are deduplicated and ordered", () => {
  assert.deepEqual(dedupeMessages([replacement, second, first]), [second, replacement])
})

test("snapshot parser rejects malformed values and clamps fields", () => {
  const snapshot = parseRoomSnapshot({
    state: {
      source: {
        kind: "storage",
        label: "movie.mp4",
        url: "https://example.com/movie.mp4",
        storagePath: "ABC234/id-movie.mp4",
        duration: 42,
        senderId: "one",
      },
      videoTime: -5,
      playing: true,
      updatedAt: 100,
      updatedBy: "one",
    },
    messages: [first, { bad: true }],
  })

  assert.equal(snapshot.state?.videoTime, 0)
  assert.equal(snapshot.state?.source?.kind, "storage")
  assert.deepEqual(snapshot.messages, [first])
})

test("snapshot merge keeps newest state and all unique messages", () => {
  const oldSnapshot: RoomSnapshot = {
    state: {
      source: null,
      videoTime: 1,
      playing: false,
      updatedAt: 10,
      updatedBy: "one",
    },
    messages: [first],
  }
  const newSnapshot: RoomSnapshot = {
    state: {
      source: null,
      videoTime: 2,
      playing: true,
      updatedAt: 20,
      updatedBy: "two",
    },
    messages: [replacement, second],
  }

  const merged = mergeSnapshots(oldSnapshot, newSnapshot)
  assert.equal(merged.state?.videoTime, 2)
  assert.deepEqual(merged.messages, [second, replacement])
})
