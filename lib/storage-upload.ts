"use client"

import { createClient, getSupabasePublicConfig } from "@/lib/supabase/client"
import { TUS_CHUNK_SIZE, uploadTusFile } from "@/lib/tus-upload"

export const VIDEO_BUCKET = "room-videos"
export { TUS_CHUNK_SIZE }
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024

interface UploadOptions {
  roomId: string
  file: File
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

interface UploadResult {
  publicUrl: string
  storagePath: string
}

function sanitizeFileName(name: string): string {
  const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
  return safe.replace(/^[-.]+|[-.]+$/g, "").slice(-120) || "video"
}

function fileSignature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function mappingKey(roomId: string, file: File): string {
  return `watch-together:upload-path:${roomId}:${fileSignature(file)}`
}

function resumeKey(storagePath: string, file: File): string {
  return `watch-together:tus-url:${storagePath}:${fileSignature(file)}`
}

export function getOrCreateStoragePath(roomId: string, file: File): string {
  const key = mappingKey(roomId, file)
  try {
    const existing = window.localStorage.getItem(key)
    if (existing) return existing
  } catch {
    // Continue with a new path when localStorage is unavailable.
  }

  const path = `${roomId}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`
  try {
    window.localStorage.setItem(key, path)
  } catch {
    // Resuming after a reload will not be available, but the upload can continue.
  }
  return path
}

function clearResumeMetadata(roomId: string, file: File, storagePath: string): void {
  try {
    window.localStorage.removeItem(mappingKey(roomId, file))
    window.localStorage.removeItem(resumeKey(storagePath, file))
  } catch {
    // No-op when storage is unavailable.
  }
}

function getStorageOrigin(supabaseUrl: string): string {
  const url = new URL(supabaseUrl)
  if (url.hostname.endsWith(".supabase.co") && !url.hostname.includes(".storage.")) {
    const projectRef = url.hostname.slice(0, -".supabase.co".length)
    return `${url.protocol}//${projectRef}.storage.supabase.co`
  }
  return url.origin
}

function readSavedUploadUrl(storagePath: string, file: File): string | null {
  try {
    return window.localStorage.getItem(resumeKey(storagePath, file))
  } catch {
    return null
  }
}

function saveUploadUrl(storagePath: string, file: File, uploadUrl: string): void {
  try {
    window.localStorage.setItem(resumeKey(storagePath, file), uploadUrl)
  } catch {
    // Resume metadata is optional.
  }
}

export async function uploadRoomVideo({
  roomId,
  file,
  signal,
  onProgress,
}: UploadOptions): Promise<UploadResult> {
  if (file.size <= 0) throw new Error("The selected file is empty.")
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error("The selected video is larger than the configured 5 GB limit.")
  }

  const storagePath = getOrCreateStoragePath(roomId, file)
  const { url, anonKey } = getSupabasePublicConfig()
  const endpoint = `${getStorageOrigin(url)}/storage/v1/upload/resumable`
  const uploadUrl = readSavedUploadUrl(storagePath, file)

  await uploadTusFile({
    endpoint,
    headers: {
      authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    metadata: {
      bucketName: VIDEO_BUCKET,
      objectName: storagePath,
      contentType: file.type || "application/octet-stream",
      cacheControl: "3600",
    },
    file,
    uploadUrl,
    signal,
    onProgress,
    onUploadUrl: (nextUrl) => saveUploadUrl(storagePath, file, nextUrl),
  })

  clearResumeMetadata(roomId, file, storagePath)
  const supabase = createClient()
  const { data } = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(storagePath)
  if (!data.publicUrl) throw new Error("Could not create a playback URL for the uploaded video.")

  return { publicUrl: data.publicUrl, storagePath }
}
