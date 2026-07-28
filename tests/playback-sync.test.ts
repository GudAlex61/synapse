import test from "node:test"
import assert from "node:assert/strict"
import {
  applyPlayerEventToSnapshot,
  nextRevision,
  shouldApplyRevision,
  type PlaybackSnapshot,
} from "../lib/playback-sync.ts"
import type { PlayerAction, PlayerEvent } from "../lib/sync-types.ts"

function command(
  senderId: string,
  counter: number,
  action: PlayerAction,
  videoTime: number,
  playing: boolean,
): PlayerEvent {
  return {
    id: `${senderId}-${counter}`,
    senderId,
    action,
    videoTime,
    playing,
    sourceId: "movie-1",
    revision: { counter, senderId },
    at: counter,
  }
}

test("two users apply play, exact seek, pause and restart deterministically", () => {
  let userA: PlaybackSnapshot = {
    sourceId: "movie-1",
    videoTime: 0,
    playing: false,
    revision: { counter: 0, senderId: "" },
  }
  let userB = { ...userA }

  const play = command("A", 1, "play", 0, true)
  userA = applyPlayerEventToSnapshot(userA, play)
  userB = applyPlayerEventToSnapshot(userB, play)
  assert.deepEqual(userB, userA)
  assert.equal(userB.videoTime, 0)
  assert.equal(userB.playing, true)

  const seekFive = command("A", 2, "seek", 5, true)
  userA = applyPlayerEventToSnapshot(userA, seekFive)
  userB = applyPlayerEventToSnapshot(userB, seekFive)
  assert.equal(userB.videoTime, 5)
  assert.equal(userB.playing, true)

  const pause = command("B", 3, "pause", 5, false)
  userA = applyPlayerEventToSnapshot(userA, pause)
  userB = applyPlayerEventToSnapshot(userB, pause)
  assert.equal(userA.videoTime, 5)
  assert.equal(userA.playing, false)

  const restart = command("B", 4, "seek", 0, false)
  userA = applyPlayerEventToSnapshot(userA, restart)
  userB = applyPlayerEventToSnapshot(userB, restart)
  assert.equal(userA.videoTime, 0)
  assert.equal(userB.videoTime, 0)
  assert.equal(userB.playing, false)

  const replay = command("B", 5, "play", 0, true)
  userA = applyPlayerEventToSnapshot(userA, replay)
  userB = applyPlayerEventToSnapshot(userB, replay)
  assert.equal(userA.videoTime, 0)
  assert.equal(userA.playing, true)

  // Delayed and duplicated commands cannot roll either user back.
  userA = applyPlayerEventToSnapshot(userA, seekFive)
  userB = applyPlayerEventToSnapshot(userB, replay)
  assert.equal(userA.videoTime, 0)
  assert.equal(userB.videoTime, 0)
  assert.deepEqual(userA.revision, { counter: 5, senderId: "B" })
})

test("Lamport revisions advance beyond local and remote counters", () => {
  assert.deepEqual(nextRevision("A", 3, { counter: 8, senderId: "B" }), {
    counter: 9,
    senderId: "A",
  })
  assert.equal(shouldApplyRevision({ counter: 8, senderId: "B" }, { counter: 8, senderId: "A" }), true)
  assert.equal(shouldApplyRevision({ counter: 7, senderId: "Z" }, { counter: 8, senderId: "A" }), false)
})


test("database fallback converges after broadcast loss and ignores stale heartbeat", () => {
  let userA: PlaybackSnapshot = {
    sourceId: "movie-1",
    videoTime: 31,
    playing: true,
    revision: { counter: 9, senderId: "A" },
  }
  let userB = { ...userA }

  // A pause broadcast is dropped, but the exact same command is persisted.
  const pauseFromDatabase = command("A", 10, "pause", 31.25, false)
  userA = applyPlayerEventToSnapshot(userA, pauseFromDatabase)
  userB = applyPlayerEventToSnapshot(userB, pauseFromDatabase)
  assert.deepEqual(userB, userA)

  // A delayed heartbeat from before the pause cannot restart playback.
  const staleHeartbeat = command("B", 9, "play", 33, true)
  userA = applyPlayerEventToSnapshot(userA, staleHeartbeat)
  userB = applyPlayerEventToSnapshot(userB, staleHeartbeat)
  assert.equal(userA.playing, false)
  assert.equal(userB.videoTime, 31.25)
})

test("simultaneous commands use a deterministic tie-breaker", () => {
  const initial: PlaybackSnapshot = {
    sourceId: "movie-1",
    videoTime: 10,
    playing: true,
    revision: { counter: 4, senderId: "" },
  }
  const fromA = command("A", 5, "pause", 10, false)
  const fromB = command("B", 5, "seek", 20, true)

  const aThenB = applyPlayerEventToSnapshot(applyPlayerEventToSnapshot(initial, fromA), fromB)
  const bThenA = applyPlayerEventToSnapshot(applyPlayerEventToSnapshot(initial, fromB), fromA)
  assert.deepEqual(aThenB, bThenA)
  assert.equal(aThenB.videoTime, 20)
  assert.equal(aThenB.playing, true)
  assert.deepEqual(aThenB.revision, { counter: 5, senderId: "B" })
})
