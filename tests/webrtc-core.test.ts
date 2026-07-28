import test from "node:test"
import assert from "node:assert/strict"
import { isSessionDescriptionPayload, parseIceServers } from "../lib/webrtc-core.ts"

test("ICE server parser accepts STUN and TURN and rejects unrelated URLs", () => {
  const servers = parseIceServers("stun:example.org:3478, https://bad.example,turns:relay.example:5349")
  assert.deepEqual(servers, [
    { urls: "stun:example.org:3478" },
    { urls: "turns:relay.example:5349" },
  ])
})

test("ICE server parser falls back to defaults", () => {
  assert.ok(parseIceServers("").length >= 1)
  assert.ok(parseIceServers("https://invalid").length >= 1)
})

test("SDP payload validator is strict and bounded", () => {
  assert.equal(isSessionDescriptionPayload({ type: "offer", sdp: "v=0" }), true)
  assert.equal(isSessionDescriptionPayload({ type: "pranswer", sdp: "v=0" }), false)
  assert.equal(isSessionDescriptionPayload({ type: "answer", sdp: "" }), false)
  assert.equal(isSessionDescriptionPayload({ type: "offer", sdp: "x".repeat(500_001) }), false)
})
