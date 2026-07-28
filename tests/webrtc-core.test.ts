import test from "node:test"
import assert from "node:assert/strict"
import {
  getIceCandidateType,
  isSessionDescriptionPayload,
  parseIceCandidatePayload,
  parseIceServers,
} from "../lib/webrtc-core.ts"

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

test("SDP payload validator requires a bounded negotiation id", () => {
  const valid = { type: "offer", sdp: "v=0", negotiationId: "12345678" }
  assert.equal(isSessionDescriptionPayload(valid), true)
  assert.equal(isSessionDescriptionPayload({ ...valid, type: "pranswer" }), false)
  assert.equal(isSessionDescriptionPayload({ ...valid, sdp: "" }), false)
  assert.equal(isSessionDescriptionPayload({ ...valid, negotiationId: "short" }), false)
  assert.equal(isSessionDescriptionPayload({ ...valid, sdp: "x".repeat(500_001) }), false)
})

test("trickled ICE candidate payload accepts candidate and end marker", () => {
  const candidate = {
    negotiationId: "12345678",
    candidate: {
      candidate: "candidate:1 1 UDP 2122260223 192.168.1.2 53000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    },
  }
  assert.deepEqual(parseIceCandidatePayload(candidate), candidate)
  assert.deepEqual(parseIceCandidatePayload({ negotiationId: "12345678", candidate: null }), {
    negotiationId: "12345678",
    candidate: null,
  })
  assert.equal(parseIceCandidatePayload({ negotiationId: "short", candidate: null }), null)
  assert.equal(parseIceCandidatePayload({ negotiationId: "12345678", candidate: { candidate: 42 } }), null)
})

test("ICE candidate type parser identifies host, srflx and relay", () => {
  assert.equal(getIceCandidateType({ candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host" }), "host")
  assert.equal(getIceCandidateType({ candidate: "candidate:2 1 udp 1 203.0.113.4 5001 typ srflx" }), "srflx")
  assert.equal(getIceCandidateType({ candidate: "candidate:3 1 udp 1 198.51.100.7 5002 typ relay" }), "relay")
  assert.equal(getIceCandidateType(null), null)
})
