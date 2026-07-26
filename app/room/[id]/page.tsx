import { notFound } from "next/navigation"
import { RoomGate } from "@/components/room-gate"
import { isValidRoomCode, normalizeRoomCode } from "@/lib/room"

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ name?: string }>
}) {
  const { id } = await params
  const { name } = await searchParams
  const roomId = normalizeRoomCode(id)
  if (!isValidRoomCode(roomId)) notFound()

  return <RoomGate roomId={roomId} initialName={name ?? ""} />
}
