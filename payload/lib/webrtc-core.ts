import type { P2PStats } from "./sync-types.ts"

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
]

export function parseIceServers(value?: string): RTCIceServer[] {
  if (!value?.trim()) return DEFAULT_ICE_SERVERS
  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("stun:") || url.startsWith("turn:") || url.startsWith("turns:"))
  return urls.length > 0 ? urls.map((urls) => ({ urls })) : DEFAULT_ICE_SERVERS
}

export function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
  timeoutMs = 10_000,
): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      connection.removeEventListener("icegatheringstatechange", onChange)
      resolve()
    }
    const onChange = () => {
      if (connection.iceGatheringState === "complete") finish()
    }
    const timeout = window.setTimeout(finish, timeoutMs)
    connection.addEventListener("icegatheringstatechange", onChange)
  })
}

export async function tuneMovieSenders(connection: RTCPeerConnection): Promise<void> {
  for (const sender of connection.getSenders()) {
    const track = sender.track
    if (!track) continue
    try {
      track.contentHint = track.kind === "video" ? "motion" : "music"
    } catch {
      // Optional browser hint.
    }
    if (track.kind !== "video") continue
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}]
      parameters.encodings[0].maxBitrate = 12_000_000
      parameters.degradationPreference = "maintain-framerate"
      await sender.setParameters(parameters)
    } catch {
      // Browser-controlled defaults remain a safe fallback.
    }
  }
}

export function isSessionDescriptionPayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { type: RTCSdpType; sdp: string } {
  return (
    (payload.type === "offer" || payload.type === "answer") &&
    typeof payload.sdp === "string" &&
    payload.sdp.length > 0 &&
    payload.sdp.length <= 500_000
  )
}

export async function readConnectionStats(
  connection: RTCPeerConnection,
  previousBytes: number | null,
  previousAt: number | null,
): Promise<{ stats: P2PStats; bytes: number | null; at: number }> {
  const report = await connection.getStats()
  let bytes: number | null = null
  let packetsLost: number | null = null
  let framesPerSecond: number | null = null
  let roundTripMs: number | null = null
  let candidateType: string | null = null
  const now = Date.now()

  const entries = new Map<string, Record<string, unknown>>()
  report.forEach((rawItem) => {
    const item = rawItem as unknown as Record<string, unknown>
    if (typeof item.id === "string") entries.set(item.id, item)
  })

  entries.forEach((item) => {
    if (item.type === "outbound-rtp" && item.kind === "video" && !item.isRemote) {
      if (typeof item.bytesSent === "number") bytes = item.bytesSent
      if (typeof item.framesPerSecond === "number") framesPerSecond = item.framesPerSecond
    }
    if (item.type === "inbound-rtp" && item.kind === "video" && !item.isRemote) {
      if (typeof item.bytesReceived === "number") bytes = item.bytesReceived
      if (typeof item.packetsLost === "number") packetsLost = item.packetsLost
      if (typeof item.framesPerSecond === "number") framesPerSecond = item.framesPerSecond
    }
    if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated) {
      if (typeof item.currentRoundTripTime === "number") roundTripMs = item.currentRoundTripTime * 1000
      const local = typeof item.localCandidateId === "string" ? entries.get(item.localCandidateId) : undefined
      const remote = typeof item.remoteCandidateId === "string" ? entries.get(item.remoteCandidateId) : undefined
      const localType = typeof local?.candidateType === "string" ? local.candidateType : null
      const remoteType = typeof remote?.candidateType === "string" ? remote.candidateType : null
      candidateType = [localType, remoteType].filter(Boolean).join(" → ") || null
    }
  })

  let bitrateKbps: number | null = null
  if (bytes !== null && previousBytes !== null && previousAt !== null && now > previousAt) {
    bitrateKbps = Math.max(0, ((bytes - previousBytes) * 8) / (now - previousAt))
  }

  return {
    stats: { bitrateKbps, roundTripMs, packetsLost, framesPerSecond, candidateType },
    bytes,
    at: now,
  }
}
