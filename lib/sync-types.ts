// Shared types for room persistence, playback commands and WebRTC signalling.

export interface LogicalRevision {
  counter: number
  senderId: string
}

export type PlayerAction = "play" | "pause" | "seek"

export interface PlayerEvent {
  id: string
  action: PlayerAction
  videoTime: number
  playing: boolean
  sourceId: string
  revision: LogicalRevision
  at: number
  senderId: string
}

export interface ChatEvent {
  id: string
  senderId: string
  senderName: string
  text: string
  at: number
}

export type SourceKind = "url" | "p2p"

export interface SourceInfo {
  kind: SourceKind
  sourceId: string
  revision: LogicalRevision
  label: string
  duration: number | null
  senderId: string
  fileSize?: number
  url?: string
  // P2P-only fields. The owner keeps the original file locally and streams the
  // decoded media over WebRTC; no movie bytes are stored in Supabase.
  ownerId?: string
  streamSessionId?: string
  mimeType?: string
  lastModified?: number
}

export interface StateResponse {
  source: SourceInfo | null
  videoTime: number
  playing: boolean
  revision: LogicalRevision
  at: number
  senderId: string
  reason: "join" | "heartbeat" | "source"
  toId?: string
}

export interface PersistedRoomState {
  source: SourceInfo | null
  videoTime: number
  playing: boolean
  revision: LogicalRevision
  updatedAt: number
  updatedBy: string
}

export interface RoomSnapshot {
  state: PersistedRoomState | null
  messages: ChatEvent[]
}

export type SystemMessage = {
  id: string
  kind: "system"
  text: string
  at: number
}

export type ChatItem = ({ kind: "chat" } & ChatEvent) | SystemMessage

export interface Peer {
  id: string
  name: string
  onlineAt: number
}

export type RtcSignalKind = "viewer-ready" | "offer" | "answer" | "ice-candidate" | "bye"

export interface RtcSignal {
  id: number
  senderId: string
  recipientId: string
  sessionId: string
  kind: RtcSignalKind
  payload: Record<string, unknown>
  at: number
}

export type P2PQualityPreset = "auto" | "high" | "balanced" | "saver"

export type P2PConnectionStatus =
  | "idle"
  | "waiting-owner"
  | "waiting-viewer"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unsupported"
  | "failed"

export interface P2PStats {
  bitrateKbps: number | null
  availableOutgoingBitrateKbps: number | null
  roundTripMs: number | null
  packetsLost: number | null
  packetLossPercent: number | null
  framesPerSecond: number | null
  frameWidth: number | null
  frameHeight: number | null
  framesDropped: number | null
  freezeCount: number | null
  jitterMs: number | null
  candidateType: string | null
  codec: string | null
  qualityLimitationReason: string | null
}
