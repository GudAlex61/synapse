import test from "node:test"
import assert from "node:assert/strict"
import { TUS_CHUNK_SIZE, uploadTusFile } from "../lib/tus-upload.ts"

function response(status: number, headers: Record<string, string> = {}, body?: string) {
  return new Response(body, { status, headers })
}

test("TUS upload uses 6 MB chunks and reports progress", async () => {
  const originalFetch = globalThis.fetch
  const file = new File(
    [new Uint8Array(TUS_CHUNK_SIZE * 2 + 17)],
    "фильм test.mp4",
    { type: "video/mp4", lastModified: 123 },
  )
  const patchSizes: number[] = []
  const progress: number[] = []
  let offset = 0
  let postMetadata = ""

  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const headers = new Headers(init.headers)
      postMetadata = headers.get("upload-metadata") ?? ""
      return response(201, { location: "/upload/one" })
    }
    if (init?.method === "PATCH") {
      const blob = init.body as Blob
      patchSizes.push(blob.size)
      offset += blob.size
      return response(204, { "upload-offset": String(offset) })
    }
    throw new Error(`Unexpected ${init?.method}`)
  }

  try {
    const uploadUrl = await uploadTusFile({
      endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable",
      headers: { authorization: "Bearer test" },
      metadata: {
        bucketName: "room-videos",
        objectName: "ABC234/file.mp4",
        contentType: "video/mp4",
      },
      file,
      onProgress: (value) => progress.push(value),
    })

    assert.equal(uploadUrl, "https://project.storage.supabase.co/upload/one")
    assert.deepEqual(patchSizes, [TUS_CHUNK_SIZE, TUS_CHUNK_SIZE, 17])
    assert.equal(progress.at(0), 0)
    assert.equal(progress.at(-1), 100)
    assert.match(postMetadata, /bucketName /)
    assert.match(postMetadata, /objectName /)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TUS upload recovers when a PATCH response is lost", async () => {
  const originalFetch = globalThis.fetch
  const file = new File([new Uint8Array(TUS_CHUNK_SIZE + 11)], "movie.mp4")
  let patchCalls = 0
  let headCalls = 0

  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PATCH") {
      patchCalls += 1
      if (patchCalls === 1) throw new TypeError("network response lost")
      return response(204, { "upload-offset": String(file.size) })
    }
    if (init?.method === "HEAD") {
      headCalls += 1
      return response(200, {
        "upload-offset": String(headCalls === 1 ? TUS_CHUNK_SIZE : file.size),
      })
    }
    throw new Error(`Unexpected ${init?.method}`)
  }

  try {
    await uploadTusFile({
      endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable",
      headers: {},
      metadata: {},
      file,
      uploadUrl: "https://project.storage.supabase.co/upload/existing",
    })

    assert.equal(headCalls, 2) // initial resume check + recovery check
    assert.equal(patchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
