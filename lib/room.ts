// Room codes are 6 uppercase alphanumeric chars, excluding easily-confused
// characters (0/O, 1/I) for readability when sharing verbally.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/

export function generateRoomCode(length = 6): string {
  if (!Number.isInteger(length) || length < 1 || length > 32) {
    throw new RangeError("Room code length must be an integer between 1 and 32.")
  }

  let code = ""
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return code
}

export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6)
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code)
}

export function normalizeDisplayName(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 24)
}

export function normalizeVideoUrl(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const normalized = url.toString()
    return normalized.length <= 4000 ? normalized : null
  } catch {
    return null
  }
}

// Stable per-tab identity. sessionStorage survives a refresh but gives separate
// tabs unique identities, unlike localStorage which made two tabs look like one peer.
export function getClientId(): string {
  if (typeof window === "undefined") return "server"
  const key = "watch-together:client-id"
  let id = window.sessionStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    window.sessionStorage.setItem(key, id)
  }
  return id
}
