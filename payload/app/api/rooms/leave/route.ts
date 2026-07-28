export const runtime = "nodejs"

function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "")
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !key) throw new Error("Supabase is not configured.")
  return { url, key }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const roomId = String(body.roomId ?? "")
    const memberId = String(body.memberId ?? "")
    const { url, key } = supabaseConfig()
    const response = await fetch(`${url}/rest/v1/rpc/leave_watch_room`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_room_id: roomId, p_member_id: memberId }),
      cache: "no-store",
    })
    if (!response.ok) throw new Error((await response.text()) || `Supabase returned ${response.status}.`)
    const result = (await response.json().catch(() => null)) as { roomCleared?: boolean } | null
    return Response.json({ ok: true, roomCleared: result?.roomCleared === true })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not leave room." },
      { status: 400 },
    )
  }
}
