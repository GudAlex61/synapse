import test from "node:test"
import assert from "node:assert/strict"
import { mergeSnapshots, parseRoomSnapshot } from "../lib/room-snapshot.ts"

const revision = { counter: 3, senderId: "owner" }

test("snapshot parser accepts P2P sources", () => {
  const snapshot = parseRoomSnapshot({
    state: {
      source: {
        kind: "p2p",
        sourceId: "source-1",
        revision,
        label: "movie.mp4",
        duration: 120,
        senderId: "owner",
        ownerId: "owner",
        streamSessionId: "session-1",
        fileSize: 500_000_000,
        mimeType: "video/mp4",
      },
      videoTime: 5,
      playing: true,
      revision,
      updatedAt: 100,
      updatedBy: "owner",
    },
    messages: [],
  })

  assert.equal(snapshot.state?.source?.kind, "p2p")
  assert.equal(snapshot.state?.source?.ownerId, "owner")
  assert.equal(snapshot.state?.source?.streamSessionId, "session-1")
  assert.equal(snapshot.state?.source?.fileSize, 500_000_000)
})

test("snapshot parser rejects incomplete P2P metadata", () => {
  const snapshot = parseRoomSnapshot({
    state: {
      source: {
        kind: "p2p",
        sourceId: "source-1",
        revision,
        label: "movie.mp4",
        duration: null,
        senderId: "owner",
      },
      videoTime: 0,
      playing: false,
      revision,
      updatedAt: 100,
      updatedBy: "owner",
    },
  })
  assert.equal(snapshot.state?.source, null)
})

test("merge keeps newest state and deduplicates chat", () => {
  const older = parseRoomSnapshot({
    state: { source: null, videoTime: 1, playing: false, revision: { counter: 1, senderId: "a" }, updatedAt: 10, updatedBy: "a" },
    messages: [{ id: "m", senderId: "a", senderName: "A", text: "old", at: 1 }],
  })
  const newer = parseRoomSnapshot({
    state: { source: null, videoTime: 2, playing: true, revision: { counter: 2, senderId: "b" }, updatedAt: 20, updatedBy: "b" },
    messages: [{ id: "m", senderId: "a", senderName: "A", text: "new", at: 2 }],
  })
  const merged = mergeSnapshots(older, newer)
  assert.equal(merged.state?.videoTime, 2)
  assert.equal(merged.messages.length, 1)
  assert.equal(merged.messages[0].text, "new")
})
