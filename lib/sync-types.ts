// Shared types for the realtime protocol and persisted room snapshot.

export type PlayerAction = "play" | "pause" | "seek" | "buffer" | "resume"

export interface PlayerEvent {
  action: PlayerAction
  // Position in the video (seconds) at the moment the sender emitted the event.
  videoTime: number
  // Sender wall-clock time (ms). Used to compensate for network latency while playing.
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

export type SourceKind = "url" | "storage" | "uploading"

export interface SourceInfo {
  // URL sources are loaded directly. Storage sources are uploaded local files
  // with a public playback URL. "uploading" is a temporary realtime hint.
  kind: SourceKind
  label: string
  url?: string
  storagePath?: string
  duration: number | null
  senderId: string
}

// Shared "current state" payload, used for two purposes:
//  - reason "join": one-time reply to a newcomer's state-request (full resync)
//  - reason "heartbeat": periodic drift-correction from the timekeeper
//  - reason "source": immediate playback state after changing a source
export interface StateResponse {
  source: SourceInfo | null
  videoTime: number
  playing: boolean
  at: number
  senderId: string
  reason: "join" | "heartbeat" | "source"
  // Only set for "join": the id of the newcomer this reply is meant for.
  toId?: string
}

export interface PersistedRoomState {
  source: SourceInfo | null
  videoTime: number
  playing: boolean
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

export type ChatItem =
  | ({ kind: "chat" } & ChatEvent)
  | SystemMessage

export interface Peer {
  id: string
  name: string
  onlineAt: number
}
