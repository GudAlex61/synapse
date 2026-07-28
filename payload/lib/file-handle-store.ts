"use client"

const DB_NAME = "synapse-local-files"
const STORE_NAME = "room-files"
const DB_VERSION = 1

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Could not open local file database."))
  })
}

export async function saveRoomFileHandle(roomId: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite")
      transaction.objectStore(STORE_NAME).put(handle, roomId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save file access."))
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save file access."))
    })
  } finally {
    db.close()
  }
}

export async function loadRoomFileHandle(roomId: string): Promise<FileSystemFileHandle | null> {
  const db = await openDatabase()
  try {
    return await new Promise<FileSystemFileHandle | null>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(roomId)
      request.onsuccess = () => resolve((request.result as FileSystemFileHandle | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error("Could not read saved file access."))
    })
  } finally {
    db.close()
  }
}

export async function clearRoomFileHandle(roomId: string): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite")
      transaction.objectStore(STORE_NAME).delete(roomId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear file access."))
    })
  } finally {
    db.close()
  }
}

export async function queryFilePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const permissionHandle = handle as FileSystemFileHandle & {
    queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  }
  if (!permissionHandle.queryPermission) return "prompt"
  return permissionHandle.queryPermission({ mode: "read" })
}

export async function requestFilePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const permissionHandle = handle as FileSystemFileHandle & {
    requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  }
  if (!permissionHandle.requestPermission) return "prompt"
  return permissionHandle.requestPermission({ mode: "read" })
}
