import test from "node:test"
import assert from "node:assert/strict"
import {
  calculateCaptureSize,
  classifyAutoQuality,
  orderMovieCodecs,
  resolveMovieEncodingPlan,
} from "../lib/webrtc-quality.ts"
import { applyMovieSenderPlan } from "../lib/webrtc-core.ts"
import type { P2PStats } from "../lib/sync-types.ts"

const BASE_STATS: P2PStats = {
  bitrateKbps: 4_500,
  availableOutgoingBitrateKbps: 12_000,
  roundTripMs: 35,
  packetsLost: 0,
  packetLossPercent: 0,
  framesPerSecond: 30,
  frameWidth: 1280,
  frameHeight: 720,
  framesDropped: 0,
  freezeCount: 0,
  jitterMs: 3,
  candidateType: "host → host",
  codec: "H264",
  qualityLimitationReason: "none",
}

test("movie codec order prefers mobile-compatible H264 before VP9 and VP8", () => {
  const ordered = orderMovieCodecs([
    { mimeType: "video/VP8" },
    { mimeType: "video/rtx" },
    { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=0;profile-level-id=42e01f" },
    { mimeType: "video/VP9" },
    { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f" },
  ])
  assert.deepEqual(ordered.map((codec) => codec.mimeType), [
    "video/H264",
    "video/H264",
    "video/VP9",
    "video/VP8",
    "video/rtx",
  ])
  assert.match(ordered[0].sdpFmtpLine ?? "", /packetization-mode=1/)
})

test("auto quality keeps a 720p source at native resolution and high bitrate", () => {
  const plan = resolveMovieEncodingPlan("auto", 0, 720)
  assert.equal(plan.targetHeight, 720)
  assert.ok(plan.maxBitrate >= 5_500_000)
  assert.equal(plan.maxFramerate, 30)
})

test("fallback capture caps mobile work at 720p while preserving aspect ratio", () => {
  assert.deepEqual(calculateCaptureSize(3840, 2160, 720), { width: 1280, height: 720 })
  assert.deepEqual(calculateCaptureSize(1920, 1080, 1080), { width: 1920, height: 1080 })
})

test("adaptive quality downgrades on bandwidth pressure and upgrades with headroom", () => {
  const plan = resolveMovieEncodingPlan("auto", 0, 1080)
  assert.equal(classifyAutoQuality({ ...BASE_STATS, availableOutgoingBitrateKbps: 2_000 }, plan), "downgrade")
  assert.equal(classifyAutoQuality({ ...BASE_STATS, qualityLimitationReason: "cpu" }, plan), "downgrade")
  assert.equal(classifyAutoQuality({ ...BASE_STATS, availableOutgoingBitrateKbps: 20_000 }, plan), "upgrade")
})

test("sender plan applies bitrate, framerate, priority and native 720p scale", async () => {
  let parameters: any = { encodings: [{}] }
  const videoTrack = {
    kind: "video",
    contentHint: "",
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    applyConstraints: async () => undefined,
  }
  const sender = {
    track: videoTrack,
    getParameters: () => structuredClone(parameters),
    setParameters: async (next: any) => { parameters = structuredClone(next) },
  }
  const connection = { getSenders: () => [sender] } as unknown as RTCPeerConnection
  const plan = await applyMovieSenderPlan(connection, "high", 0)
  assert.equal(plan?.targetHeight, 720)
  assert.ok(parameters.encodings[0].maxBitrate >= 6_000_000)
  assert.equal(parameters.encodings[0].maxFramerate, 30)
  assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1)
  assert.equal(parameters.encodings[0].priority, "high")
  assert.equal(parameters.degradationPreference, "maintain-resolution")
})
