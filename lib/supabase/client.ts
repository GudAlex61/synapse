import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

let client: SupabaseClient | undefined

export interface SupabasePublicConfig {
  url: string
  anonKey: string
}

export function getSupabasePublicConfig(): SupabasePublicConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    )
  }

  return { url: url.replace(/\/$/, ""), anonKey }
}

// Singleton browser client. It is shared by Realtime, database RPC calls and Storage.
export function createClient() {
  if (client) return client
  const { url, anonKey } = getSupabasePublicConfig()
  client = createBrowserClient(url, anonKey)
  return client
}
