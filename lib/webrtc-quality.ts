import type { P2PQualityPreset, P2PStats } from "./sync-types.ts"

export type AdaptiveQualityLevel = 0 | 1 | 2

export interface MovieEncodingPlan {
  preset: P2PQualityPreset
  level: AdaptiveQualityLevel
  targetHeight: number
  maxBitrate: number
  maxFramerate: number
  degradationPreference: RTCDegradationPreference
  label: string
}

export interface CodecLike {
  mimeType: string
  sdpFmtpLine?: string
}

const AUTO_PLANS: Array<Omit<MovieEncodingPlan, "preset" | "level">> = [
  {
    targetHeight: 1080,
    maxBitrate: 9_000_000,
    maxFramerate: 30,
    degradationPreference: "balanced",
    label: "авто · высокое",
  },
  {
    targetHeight: 720,
    maxBitrate: 5_000_000,
    maxFramerate: 30,
    degradationPreference: "balanced",
    label: "авто · стабильное",
  },
  {
    targetHeight: 540,
    maxBitrate: 2_400_000,
    maxFramerate: 24,
    degradationPreference: "maintain-framerate",
    label: "авто · экономное",
  },
]

const MANUAL_PLANS: Record<Exclude<P2PQualityPreset, "auto">, Omit<MovieEncodingPlan, "preset" | "level">> = {
  high: {
    targetHeight: 1080,
    maxBitrate: 10_000_000,
    maxFramerate: 30,
    degradationPreference: "maintain-resolution",
    label: "высокое качество",
  },
  balanced: {
    targetHeight: 720,
    maxBitrate: 5_000_000,
    maxFramerate: 30,
    degradationPreference: "balanced",
    label: "стабильное 720p",
  },
  saver: {
    targetHeight: 540,
    maxBitrate: 2_400_000,
    maxFramerate: 24,
    degradationPreference: "maintain-framerate",
    label: "экономия трафика",
  },
}

export function resolveMovieEncodingPlan(
  preset: P2PQualityPreset,
  level: AdaptiveQualityLevel,
  sourceHeight?: number,
): MovieEncodingPlan {
  const base = preset === "auto" ? AUTO_PLANS[level] : MANUAL_PLANS[preset]
  const actualHeight = Number.isFinite(sourceHeight) && sourceHeight && sourceHeight > 0
    ? Math.max(144, Math.round(sourceHeight))
    : base.targetHeight
  const targetHeight = Math.min(actualHeight, base.targetHeight)
  const bitrateScale = targetHeight < base.targetHeight ? Math.max(0.55, targetHeight / base.targetHeight) : 1
  return {
    ...base,
    preset,
    level,
    targetHeight,
    maxBitrate: Math.round(base.maxBitrate * bitrateScale),
  }
}

function codecRank(codec: CodecLike): number {
  const mime = codec.mimeType.toLowerCase()
  if (mime === "video/h264") {
    const fmtp = codec.sdpFmtpLine?.toLowerCase() ?? ""
    // Constrained-baseline and packetization-mode=1 are the safest common
    // H.264 variants for mobile Safari/Chrome interoperability.
    if (/profile-level-id=42/.test(fmtp) && /packetization-mode=1/.test(fmtp)) return 0
    if (/packetization-mode=1/.test(fmtp)) return 1
    return 2
  }
  if (mime === "video/vp9") return 3
  if (mime === "video/vp8") return 4
  if (mime === "video/av1") return 5
  if (mime === "video/rtx") return 20
  if (mime === "video/red") return 21
  if (mime === "video/ulpfec") return 22
  return 10
}

export function orderMovieCodecs<T extends CodecLike>(codecs: readonly T[]): T[] {
  return codecs
    .map((codec, index) => ({ codec, index, rank: codecRank(codec) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ codec }) => codec)
}

export function calculateCaptureSize(width: number, height: number, maxHeight: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1280
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 720
  const boundedHeight = Math.min(safeHeight, Math.max(144, maxHeight))
  const scale = boundedHeight / safeHeight
  return {
    width: Math.max(2, Math.round((safeWidth * scale) / 2) * 2),
    height: Math.max(2, Math.round(boundedHeight / 2) * 2),
  }
}

export type AutoQualityDecision = "upgrade" | "downgrade" | "hold"

export function classifyAutoQuality(stats: P2PStats, currentPlan: MovieEncodingPlan): AutoQualityDecision {
  const bitrateHeadroom = stats.availableOutgoingBitrateKbps === null
    ? null
    : stats.availableOutgoingBitrateKbps / (currentPlan.maxBitrate / 1000)
  const limitation = stats.qualityLimitationReason
  const packetLoss = stats.packetLossPercent
  const rtt = stats.roundTripMs
  const fps = stats.framesPerSecond

  if (
    limitation === "bandwidth" ||
    limitation === "cpu" ||
    (bitrateHeadroom !== null && bitrateHeadroom < 0.72) ||
    (packetLoss !== null && packetLoss > 4) ||
    (rtt !== null && rtt > 350) ||
    (fps !== null && fps > 0 && fps < 16)
  ) {
    return "downgrade"
  }

  if (
    (limitation === null || limitation === "none") &&
    (bitrateHeadroom === null || bitrateHeadroom > 1.45) &&
    (packetLoss === null || packetLoss < 1) &&
    (rtt === null || rtt < 150) &&
    (fps === null || fps >= 23)
  ) {
    return "upgrade"
  }

  return "hold"
}
