import type { P2PQualityPreset, P2PStats } from "./sync-types.ts"
import {
  orderMovieCodecs,
  resolveMovieEncodingPlan,
  type AdaptiveQualityLevel,
  type MovieEncodingPlan,
} from "./webrtc-quality.ts"

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
]

export function parseIceServers(value?: string): RTCIceServer[] {
  if (!value?.trim()) return DEFAULT_ICE_SERVERS
  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("stun:") || url.startsWith("turn:") || url.startsWith("turns:"))
  return urls.length > 0 ? urls.map((urls) => ({ urls })) : DEFAULT_ICE_SERVERS
}

export function configureMovieCodecs(connection: RTCPeerConnection): string[] {
  const capabilities = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null
  if (!capabilities?.codecs?.length) return []
  const ordered = orderMovieCodecs(capabilities.codecs)
  const applied: string[] = []
  for (const transceiver of connection.getTransceivers()) {
    if (transceiver.sender.track?.kind !== "video" || typeof transceiver.setCodecPreferences !== "function") continue
    try {
      transceiver.setCodecPreferences(ordered)
      applied.push(...ordered.map((codec) => codec.mimeType))
    } catch {
      // The browser default remains a safe fallback on older mobile versions.
    }
  }
  return [...new Set(applied)]
}

type MutableEncoding = RTCRtpEncodingParameters & {
  networkPriority?: "very-low" | "low" | "medium" | "high"
}

export async function applyMovieSenderPlan(
  connection: RTCPeerConnection,
  preset: P2PQualityPreset,
  level: AdaptiveQualityLevel,
): Promise<MovieEncodingPlan | null> {
  let selectedPlan: MovieEncodingPlan | null = null
  for (const sender of connection.getSenders()) {
    const track = sender.track
    if (!track) continue
    try {
      track.contentHint = track.kind === "video" ? "motion" : "music"
    } catch {
      // Optional browser hint.
    }

    const parameters = sender.getParameters()
    parameters.encodings ??= [{}]
    const encoding = parameters.encodings[0] as MutableEncoding
    encoding.priority = "high"
    encoding.networkPriority = "high"

    if (track.kind === "audio") {
      encoding.maxBitrate = 192_000
      await sender.setParameters(parameters).catch(() => undefined)
      continue
    }
    if (track.kind !== "video") continue

    const settings = track.getSettings?.() ?? {}
    const sourceHeight = typeof settings.height === "number" ? settings.height : undefined
    const plan = resolveMovieEncodingPlan(preset, level, sourceHeight)
    selectedPlan = plan
    encoding.maxBitrate = plan.maxBitrate
    encoding.maxFramerate = plan.maxFramerate
    if (sourceHeight && sourceHeight > plan.targetHeight) {
      encoding.scaleResolutionDownBy = Math.max(1, sourceHeight / plan.targetHeight)
    } else {
      encoding.scaleResolutionDownBy = 1
    }
    parameters.degradationPreference = plan.degradationPreference

    try {
      await sender.setParameters(parameters)
    } catch {
      // Safari and older Chromium builds may reject one optional field. Retry
      // with the broadly-supported bitrate/framerate subset.
      try {
        const fallback = sender.getParameters()
        fallback.encodings ??= [{}]
        fallback.encodings[0].maxBitrate = plan.maxBitrate
        fallback.encodings[0].maxFramerate = plan.maxFramerate
        fallback.degradationPreference = plan.degradationPreference
        await sender.setParameters(fallback)
      } catch {
        // Browser congestion control remains available even without overrides.
      }
    }

    const applied = sender.getParameters().encodings?.[0]
    if (
      sourceHeight &&
      sourceHeight > plan.targetHeight &&
      (!applied?.scaleResolutionDownBy || applied.scaleResolutionDownBy <= 1) &&
      typeof track.applyConstraints === "function"
    ) {
      await track.applyConstraints({
        height: { max: plan.targetHeight },
        frameRate: { max: plan.maxFramerate },
      }).catch(() => undefined)
    }
  }
  return selectedPlan
}

// Kept for compatibility with older callers and tests.
export async function tuneMovieSenders(connection: RTCPeerConnection): Promise<void> {
  await applyMovieSenderPlan(connection, "auto", 0)
}

export function isSessionDescriptionPayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { type: RTCSdpType; sdp: string; negotiationId: string } {
  return (
    (payload.type === "offer" || payload.type === "answer") &&
    typeof payload.sdp === "string" &&
    payload.sdp.length > 0 &&
    payload.sdp.length <= 500_000 &&
    typeof payload.negotiationId === "string" &&
    payload.negotiationId.length >= 8 &&
    payload.negotiationId.length <= 100
  )
}

export interface IceCandidateSignalPayload {
  negotiationId: string
  candidate: RTCIceCandidateInit | null
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string"
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || (typeof value === "number" && Number.isInteger(value))
}

export function parseIceCandidatePayload(payload: Record<string, unknown>): IceCandidateSignalPayload | null {
  if (
    typeof payload.negotiationId !== "string" ||
    payload.negotiationId.length < 8 ||
    payload.negotiationId.length > 100
  ) {
    return null
  }
  if (payload.candidate === null) {
    return { negotiationId: payload.negotiationId, candidate: null }
  }
  if (typeof payload.candidate !== "object" || payload.candidate === null) return null
  const candidate = payload.candidate as Record<string, unknown>
  if (
    typeof candidate.candidate !== "string" ||
    candidate.candidate.length > 10_000 ||
    !isNullableString(candidate.sdpMid) ||
    !isNullableNumber(candidate.sdpMLineIndex) ||
    !isNullableString(candidate.usernameFragment)
  ) {
    return null
  }
  return {
    negotiationId: payload.negotiationId,
    candidate: {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    },
  }
}

export function getIceCandidateType(candidate: RTCIceCandidateInit | null): string | null {
  if (!candidate?.candidate) return null
  const match = candidate.candidate.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)
  return match?.[1]?.toLowerCase() ?? null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readCodec(entries: Map<string, Record<string, unknown>>, codecId: unknown): string | null {
  if (typeof codecId !== "string") return null
  const codec = entries.get(codecId)
  if (!codec) return null
  const mimeType = typeof codec.mimeType === "string" ? codec.mimeType : null
  const fmtp = typeof codec.sdpFmtpLine === "string" && codec.sdpFmtpLine ? codec.sdpFmtpLine : null
  return mimeType ? `${mimeType.replace(/^video\//i, "")}${fmtp ? ` (${fmtp})` : ""}` : null
}

export async function readConnectionStats(
  connection: RTCPeerConnection,
  previousBytes: number | null,
  previousAt: number | null,
): Promise<{ stats: P2PStats; bytes: number | null; at: number }> {
  const report = await connection.getStats()
  let bytes: number | null = null
  let packetsLost: number | null = null
  let packetsTotal: number | null = null
  let framesPerSecond: number | null = null
  let frameWidth: number | null = null
  let frameHeight: number | null = null
  let framesDropped: number | null = null
  let freezeCount: number | null = null
  let jitterMs: number | null = null
  let roundTripMs: number | null = null
  let availableOutgoingBitrateKbps: number | null = null
  let candidateType: string | null = null
  let codec: string | null = null
  let qualityLimitationReason: string | null = null
  const now = Date.now()

  const entries = new Map<string, Record<string, unknown>>()
  report.forEach((rawItem) => {
    const item = rawItem as unknown as Record<string, unknown>
    if (typeof item.id === "string") entries.set(item.id, item)
  })

  entries.forEach((item) => {
    const kind = item.kind ?? item.mediaType
    if (item.type === "outbound-rtp" && kind === "video" && !item.isRemote) {
      bytes = finiteNumber(item.bytesSent) ?? bytes
      framesPerSecond = finiteNumber(item.framesPerSecond) ?? framesPerSecond
      frameWidth = finiteNumber(item.frameWidth) ?? frameWidth
      frameHeight = finiteNumber(item.frameHeight) ?? frameHeight
      framesDropped = finiteNumber(item.framesDropped) ?? framesDropped
      qualityLimitationReason = typeof item.qualityLimitationReason === "string" ? item.qualityLimitationReason : qualityLimitationReason
      codec = readCodec(entries, item.codecId) ?? codec
    }
    if (item.type === "inbound-rtp" && kind === "video" && !item.isRemote) {
      bytes = finiteNumber(item.bytesReceived) ?? bytes
      packetsLost = finiteNumber(item.packetsLost) ?? packetsLost
      const packetsReceived = finiteNumber(item.packetsReceived)
      if (packetsReceived !== null) packetsTotal = packetsReceived + Math.max(0, packetsLost ?? 0)
      framesPerSecond = finiteNumber(item.framesPerSecond) ?? framesPerSecond
      frameWidth = finiteNumber(item.frameWidth) ?? frameWidth
      frameHeight = finiteNumber(item.frameHeight) ?? frameHeight
      framesDropped = finiteNumber(item.framesDropped) ?? framesDropped
      freezeCount = finiteNumber(item.freezeCount) ?? freezeCount
      const jitter = finiteNumber(item.jitter)
      if (jitter !== null) jitterMs = jitter * 1000
      codec = readCodec(entries, item.codecId) ?? codec
    }
    if (item.type === "remote-inbound-rtp" && kind === "video") {
      packetsLost = finiteNumber(item.packetsLost) ?? packetsLost
      const packetsReceived = finiteNumber(item.packetsReceived)
      if (packetsReceived !== null) packetsTotal = packetsReceived + Math.max(0, packetsLost ?? 0)
      const remoteRtt = finiteNumber(item.roundTripTime)
      if (remoteRtt !== null) roundTripMs = remoteRtt * 1000
      const jitter = finiteNumber(item.jitter)
      if (jitter !== null) jitterMs = jitter * 1000
    }
    if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated) {
      const pairRtt = finiteNumber(item.currentRoundTripTime)
      if (pairRtt !== null) roundTripMs = pairRtt * 1000
      const available = finiteNumber(item.availableOutgoingBitrate)
      if (available !== null) availableOutgoingBitrateKbps = available / 1000
      const local = typeof item.localCandidateId === "string" ? entries.get(item.localCandidateId) : undefined
      const remote = typeof item.remoteCandidateId === "string" ? entries.get(item.remoteCandidateId) : undefined
      const localType = typeof local?.candidateType === "string" ? local.candidateType : null
      const remoteType = typeof remote?.candidateType === "string" ? remote.candidateType : null
      candidateType = [localType, remoteType].filter(Boolean).join(" → ") || null
    }
  })

  let bitrateKbps: number | null = null
  if (bytes !== null && previousBytes !== null && previousAt !== null && now > previousAt && bytes >= previousBytes) {
    bitrateKbps = Math.max(0, ((bytes - previousBytes) * 8) / (now - previousAt))
  }
  const packetLossPercent = packetsLost !== null && packetsTotal && packetsTotal > 0
    ? Math.max(0, Math.min(100, (packetsLost / packetsTotal) * 100))
    : null

  return {
    stats: {
      bitrateKbps,
      availableOutgoingBitrateKbps,
      roundTripMs,
      packetsLost,
      packetLossPercent,
      framesPerSecond,
      frameWidth,
      frameHeight,
      framesDropped,
      freezeCount,
      jitterMs,
      candidateType,
      codec,
      qualityLimitationReason,
    },
    bytes,
    at: now,
  }
}
