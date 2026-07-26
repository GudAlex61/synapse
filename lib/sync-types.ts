// Shared types for the realtime protocol.

export type PlayerAction = "play" | "pause" | "seek" | "buffer" | "resume"

export interface PlayerEvent {
  action: PlayerAction
  // Position in the video (seconds) at the moment the sender emitted the event.
  videoTime: number
  // Sender wall-clock time (ms). Used to compensate for network latency.
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

export interface SourceInfo {
  // "url" sources can be auto-loaded by the peer. "file" sources cannot be
  // transferred, so the peer is asked to pick the same file locally.
  kind: "url" | "file"
  label: string // url string or file name
  url?: string // only present for kind === "url"
  duration: number | null
  senderId: string
}

// Shared "current state" payload, used for two purposes:
//  - reason "join": one-time reply to a newcomer's state-request (full resync)
//  - reason "heartbeat": periodic drift-correction from the timekeeper
export interface StateResponse {
  source: SourceInfo | null
  videoTime: number
  playing: boolean
  at: number
  senderId: string
  reason: "join" | "heartbeat"
  // Only set for "join": the id of the newcomer this reply is meant for.
  toId?: string
}

export type SystemMessage = {
  id: string
  kind: "system"
  text: string
  at: number
}

export type ChatItem =
  | ({ kind: "chat" } & ChatEvent)
  | SystemMessage

export interface Peer {
  id: string
  name: string
  onlineAt: number
}
