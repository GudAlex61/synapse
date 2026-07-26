// Room codes are 6 uppercase alphanumeric chars, excluding easily-confused
// characters (0/O, 1/I) for readability when sharing verbally.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function generateRoomCode(length = 6): string {
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
  return /^[A-Z0-9]{6}$/.test(code)
}

// Stable per-browser identity so we can distinguish the two participants
// across reconnects without any auth.
export function getClientId(): string {
  if (typeof window === "undefined") return "server"
  const KEY = "watch-together:client-id"
  let id = window.localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    window.localStorage.setItem(KEY, id)
  }
  return id
}
