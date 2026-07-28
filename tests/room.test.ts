import test from "node:test"
import assert from "node:assert/strict"
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeDisplayName,
  normalizeRoomCode,
  normalizeVideoUrl,
} from "../lib/room.ts"

test("generated room codes are valid and avoid ambiguous characters", () => {
  for (let index = 0; index < 2_000; index += 1) {
    const code = generateRoomCode()
    assert.equal(code.length, 6)
    assert.equal(isValidRoomCode(code), true)
    assert.doesNotMatch(code, /[01IO]/)
  }
})

test("room code normalization and validation are strict", () => {
  assert.equal(normalizeRoomCode(" ab-c23 4 "), "ABC234")
  assert.equal(isValidRoomCode("ABC234"), true)
  assert.equal(isValidRoomCode("ABC01I"), false)
  assert.equal(isValidRoomCode("ABC23"), false)
})

test("display names are trimmed, collapsed and bounded", () => {
  assert.equal(normalizeDisplayName("  Ada   Lovelace  "), "Ada Lovelace")
  assert.equal(normalizeDisplayName("x".repeat(50)).length, 24)
})

test("video URLs allow only http and https", () => {
  assert.equal(normalizeVideoUrl("javascript:alert(1)"), null)
  assert.equal(normalizeVideoUrl("not a url"), null)
  assert.equal(normalizeVideoUrl("https://example.com/movie.mp4"), "https://example.com/movie.mp4")
})
