/**
 * Information about a single entry (file) within a pack archive.
 *
 * This is the public-facing representation of an entry, derived from the
 * internal `PackIndexEntry` after deserialization.
 */
export interface PackEntryInfo {
  /** Virtual path of the entry inside the pack (e.g. `images/cover.png`). */
  path: string

  /** MIME type of the entry content (e.g. `image/png`). */
  mimeType: string

  /** Uncompressed size in bytes. */
  size: number

  /** Compressed size in bytes (equal to `size` when compression is disabled). */
  compressedSize: number

  /** Bitmask of `EntryFlags` describing entry-level attributes. */
  flags: number

  /** Absolute byte offset of the entry payload within the pack file. */
  offset?: bigint

  /** AES-GCM IV (12 bytes) when identity binding is enabled. */
  iv?: Uint8Array
}

/**
 * High-level metadata describing a pack archive.
 */
export interface PackMetadata {
  /** Format version of the pack (e.g. `1` for MVP). */
  version: number

  /** Bitmask of `PackFlags` describing archive-level attributes. */
  flags: number

  /** Timestamp when the pack was created. */
  createdAt: Date

  /** Total number of entries in the archive. */
  entryCount: number

  indexOffset?: bigint
  indexSize?: bigint
}

/**
 * Progress snapshot emitted during pack creation or extraction.
 */
export type PackProgress = {
  /** Current operation phase. */
  phase: 'scanning' | 'packing' | 'indexing' | 'finalizing'

  /** Number of entries processed so far. */
  current: number

  /** Total number of entries to process. */
  total: number

  /** Bytes processed so far. */
  bytesProcessed: number

  /** Total bytes to process. */
  bytesTotal: number
}

/**
 * Options controlling pack creation behaviour.
 */
export type PackOptions = {
  /** Compression algorithm to use. Default: `'none'`. */
  compression?: 'none' | 'deflate'

  /**
   * Whether to bind the pack to the user's identity key.
   *
   * When `true`, the pack header and every entry are cryptographically
   * bound to the current identity, preventing repudiation.
   *
   * @default false
   */
  identityBinding?: boolean
}

/**
 * Options controlling read / extraction behaviour.
 */
export type ReadOptions = {
  decompress?: boolean
  identitySub?: string
  packId?: string
}

/**
 * Per-entry options used when adding a file to a pack.
 */
export type EntryOptions = {
  /** Whether to compress this entry individually. */
  compress?: boolean
}

/**
 * Communication contract between the main thread and a Web Worker
 * responsible for Arrow IPC encoding / decoding and shared-buffer
 * coordination.
 *
 * The `ipcChannel` identifies the Arrow IPC stream, while
 * `sharedBuffer` is a `SharedArrayBuffer` used for zero-copy
 * metadata exchange.
 */
export interface PackWorkerAPI {
  /** Logical name of the Arrow IPC channel. */
  ipcChannel: string

  /** Shared buffer for lock-free coordination between threads. */
  sharedBuffer: SharedArrayBuffer | ArrayBuffer
}

/**
 * Zero-copy proxy object used when transferring an entry across
 * thread boundaries (e.g. from a Worker back to the main thread).
 *
 * The `transfer` array lists `ArrayBuffer` instances that should be
 * moved (not cloned) via `postMessage` to avoid memory duplication.
 */
export interface PackEntryProxy {
  /** Virtual path of the entry. */
  path: string

  /** MIME type of the entry. */
  mimeType: string

  /** Raw entry payload (potentially compressed). */
  data: Uint8Array

  /** Buffers that must be transferred (not copied) during postMessage. */
  transfer: ArrayBuffer[]
}
