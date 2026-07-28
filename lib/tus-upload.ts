export const TUS_CHUNK_SIZE = 6 * 1024 * 1024
const TUS_VERSION = "1.0.0"
const RETRY_DELAYS = [0, 1_000, 3_000, 5_000, 10_000]

export interface TusUploadOptions {
  endpoint: string
  headers: Record<string, string>
  metadata: Record<string, string>
  file: File
  uploadUrl?: string | null
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  onUploadUrl?: (uploadUrl: string) => void
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timeout)
        reject(new DOMException("Upload cancelled", "AbortError"))
      },
      { once: true },
    )
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  const block = 8_192
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block))
  }
  return btoa(binary)
}

function encodeMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${encodeBase64(value)}`)
    .join(",")
}

async function createUpload(options: TusUploadOptions): Promise<string> {
  let lastError: unknown

  for (const delay of RETRY_DELAYS) {
    options.signal?.throwIfAborted()
    await sleep(delay, options.signal)
    try {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          ...options.headers,
          "Tus-Resumable": TUS_VERSION,
          "Upload-Length": String(options.file.size),
          "Upload-Metadata": encodeMetadata(options.metadata),
        },
        signal: options.signal,
      })

      if (response.ok) {
        const location = response.headers.get("location")
        if (!location) throw new Error("Upload server did not return a resumable URL.")
        return new URL(location, options.endpoint).toString()
      }

      if (!isRetryableStatus(response.status)) {
        throw new Error((await response.text()) || `Could not start upload (${response.status}).`)
      }
      lastError = new Error(`Upload server returned ${response.status}.`)
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not start upload.")
}

async function getUploadOffset(
  uploadUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<number | null> {
  const response = await fetch(uploadUrl, {
    method: "HEAD",
    headers: { ...headers, "Tus-Resumable": TUS_VERSION },
    signal,
  })
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) throw new Error(`Could not resume upload (${response.status}).`)
  const offset = Number(response.headers.get("upload-offset"))
  return Number.isFinite(offset) && offset >= 0 ? offset : null
}

async function uploadChunk(
  uploadUrl: string,
  options: TusUploadOptions,
  offset: number,
): Promise<number> {
  const end = Math.min(offset + TUS_CHUNK_SIZE, options.file.size)
  const chunk = options.file.slice(offset, end)
  let lastError: unknown

  for (const delay of RETRY_DELAYS) {
    options.signal?.throwIfAborted()
    await sleep(delay, options.signal)
    try {
      const response = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          ...options.headers,
          "Tus-Resumable": TUS_VERSION,
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: chunk,
        signal: options.signal,
      })

      if (response.ok) {
        const serverOffset = Number(response.headers.get("upload-offset"))
        return Number.isFinite(serverOffset) && serverOffset > offset ? serverOffset : end
      }

      if (!isRetryableStatus(response.status)) {
        throw new Error((await response.text()) || `Upload failed (${response.status}).`)
      }
      lastError = new Error(`Upload server returned ${response.status}.`)
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }

    // A chunk can reach the server even when its response is lost. HEAD keeps
    // the client from re-sending bytes at an already-advanced offset.
    try {
      const serverOffset = await getUploadOffset(uploadUrl, options.headers, options.signal)
      if (serverOffset === null) throw new Error("The resumable upload expired.")
      if (serverOffset > offset) return serverOffset
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Upload failed after retries.")
}

export async function uploadTusFile(options: TusUploadOptions): Promise<string> {
  let uploadUrl = options.uploadUrl ?? null
  let offset = 0

  if (uploadUrl) {
    try {
      const savedOffset = await getUploadOffset(uploadUrl, options.headers, options.signal)
      if (savedOffset === null || savedOffset > options.file.size) uploadUrl = null
      else offset = savedOffset
    } catch {
      uploadUrl = null
    }
  }

  if (!uploadUrl) {
    uploadUrl = await createUpload(options)
    options.onUploadUrl?.(uploadUrl)
  }

  options.onProgress?.((offset / options.file.size) * 100)
  while (offset < options.file.size) {
    offset = await uploadChunk(uploadUrl, options, offset)
    options.onProgress?.((offset / options.file.size) * 100)
  }

  return uploadUrl
}
