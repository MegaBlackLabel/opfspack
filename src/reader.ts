import {
  HEADER_SIZE,
  FORMAT_VERSION,
  LITTLE_ENDIAN,
  EntryFlags,
  deserializeHeader,
  deserializeIndexEntry,
  calcIndexEntrySize,
  validateMagic,
  type PackHeader,
  type PackIndexEntry,
} from './format.js'

import {
  deriveMasterKey,
  derivePackKey,
  decryptEntry,
} from './auth/identity-key.js'

import { inflate } from 'fflate'
import type { PackEntryInfo, PackMetadata, ReadOptions } from './types.js'
import { PackVersionError, PackCorruptedError } from './errors.js'
import { LRUCache } from './cache.js'

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function inflateAsync(data: Uint8Array): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    inflate(data, (err, result) => {
      if (err) {
        reject(new Error(`Decompression failed: ${err.message}`))
      } else {
        const buf = new ArrayBuffer(result.byteLength)
        new Uint8Array(buf).set(result)
        resolve(buf)
      }
    })
  })
}

export class PackReader {
  private buffer: ArrayBuffer
  private header: PackHeader
  private indexMap: Map<string, PackIndexEntry> | null = null
  private indexEntries: PackIndexEntry[] | null = null
  private closed = false
  private cache: LRUCache

  private constructor(buffer: ArrayBuffer, cacheSize = 50 * 1024 * 1024) {
    this.buffer = buffer
    this.header = this.parseHeader()
    this.cache = new LRUCache(cacheSize)
  }

  static fromBuffer(buffer: ArrayBuffer): PackReader {
    return new PackReader(buffer)
  }

  static async fromOPFS(fileHandle: FileSystemFileHandle): Promise<PackReader> {
    const file = await fileHandle.getFile()
    const buffer = await file.arrayBuffer()
    return new PackReader(buffer)
  }

  private parseHeader(): PackHeader {
    if (this.buffer.byteLength < HEADER_SIZE) {
      throw new PackCorruptedError('Buffer too small for header')
    }
    const magic = new Uint8Array(this.buffer, 0, 4)
    if (!validateMagic(magic)) {
      throw new PackCorruptedError('Invalid magic number: expected OPFS')
    }
    try {
      const header = deserializeHeader(this.buffer.slice(0, HEADER_SIZE))
      if (header.version !== FORMAT_VERSION) {
        throw new PackVersionError(`Unsupported pack version: ${header.version}`)
      }
      return header
    } catch (e) {
      if (e instanceof PackVersionError) throw e
      throw new PackCorruptedError(
        e instanceof Error ? e.message : 'Header validation failed'
      )
    }
  }

  get metadata(): PackMetadata {
    this.ensureOpen()
    return {
      version: this.header.version,
      flags: this.header.flags,
      entryCount: this.header.entryCount,
      createdAt: new Date(Number(this.header.createdAt)),
      indexOffset: this.header.indexOffset,
      indexSize: this.header.indexSize,
    }
  }

  hasEntry(path: string): boolean {
    this.ensureOpen()
    this.parseIndexIfNeeded()
    return this.indexMap!.has(path)
  }

  getEntryInfo(path: string): PackEntryInfo | undefined {
    this.ensureOpen()
    this.parseIndexIfNeeded()
    const entry = this.indexMap!.get(path)
    if (!entry) return undefined
    return {
      path: entry.path,
      mimeType: entry.mimeType,
      size: Number(entry.size),
      compressedSize: Number(entry.compressedSize),
      flags: entry.flags,
      offset: entry.offset,
    }
  }

  private validateBigInt(value: bigint, name: string): number {
    if (value < 0) {
      throw new PackCorruptedError(`${name} is negative`)
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new PackCorruptedError(`${name} exceeds safe integer range`)
    }
    return Number(value)
  }

  async readEntry(path: string, options?: ReadOptions): Promise<ArrayBuffer> {
    this.ensureOpen()
    this.parseIndexIfNeeded()
    
    const cacheKey = `${this.header.createdAt}-${path}-${options?.identitySub ?? 'no-id'}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }
    
    const entry = this.indexMap!.get(path)
    if (!entry) {
      throw new Error(`Entry not found: ${path}`)
    }
    const start = this.validateBigInt(entry.offset, 'entry.offset')
    const size = this.validateBigInt(entry.compressedSize, 'entry.compressedSize')
    const end = start + size
    if (end > this.buffer.byteLength) {
      throw new PackCorruptedError('Entry extends beyond buffer')
    }
    let data = this.buffer.slice(start, end)

    if ((entry.flags & EntryFlags.IdentityBound) && options?.identitySub && options?.packId) {
      const masterKey = await deriveMasterKey(options.identitySub)
      const packKey = await derivePackKey(masterKey, options.packId)
      data = await decryptEntry(data, entry.iv, packKey)
    }

    if (entry.flags & EntryFlags.Compressed) {
      data = await inflateAsync(new Uint8Array(data))
    }

    this.cache.set(cacheKey, data)
    return data
  }

  async readEntryRange(
    path: string,
    start: number,
    end: number,
    options?: ReadOptions
  ): Promise<ArrayBuffer> {
    this.ensureOpen()
    this.parseIndexIfNeeded()
    const entry = this.indexMap!.get(path)
    if (!entry) {
      throw new Error(`Entry not found: ${path}`)
    }
    if (start < 0 || end > Number(entry.size) || start >= end) {
      throw new Error('Invalid range')
    }
    const fullData = await this.readEntry(path, options)
    return fullData.slice(start, end)
  }

  listEntries(): PackEntryInfo[] {
    this.ensureOpen()
    this.parseIndexIfNeeded()
    return this.indexEntries!.map((entry) => ({
      path: entry.path,
      mimeType: entry.mimeType,
      size: Number(entry.size),
      compressedSize: Number(entry.compressedSize),
      flags: entry.flags,
      offset: entry.offset,
    }))
  }

  close(): void {
    this.closed = true
    this.indexMap = null
    this.indexEntries = null
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('PackReader is closed')
    }
  }

  private parseIndexIfNeeded(): void {
    if (this.indexMap !== null) return

    const indexOffset = this.validateBigInt(this.header.indexOffset, 'header.indexOffset')
    const indexSize = this.validateBigInt(this.header.indexSize, 'header.indexSize')

    if (indexOffset + indexSize > this.buffer.byteLength) {
      throw new PackCorruptedError('Index extends beyond buffer')
    }

    if (indexSize < 4) {
      throw new PackCorruptedError('Index too small for CRC')
    }

    const indexEnd = indexOffset + indexSize

    const storedCrc = new DataView(this.buffer, indexEnd - 4, 4).getUint32(0, LITTLE_ENDIAN)
    const computedCrc = crc32(new Uint8Array(this.buffer, indexOffset, indexSize - 4))

    if (storedCrc !== computedCrc) {
      throw new PackCorruptedError(
        `Index CRC mismatch: stored=${storedCrc}, computed=${computedCrc}`
      )
    }

    const indexMap = new Map<string, PackIndexEntry>()
    const indexEntries: PackIndexEntry[] = []
    let pos = 0
    const entriesData = new Uint8Array(this.buffer, indexOffset, indexSize - 4)

    for (let i = 0; i < this.header.entryCount; i++) {
      if (pos >= entriesData.byteLength) {
        throw new PackCorruptedError(
          `Index truncated: expected ${this.header.entryCount} entries`
        )
      }
      try {
        const entry = deserializeIndexEntry(
          entriesData.buffer.slice(entriesData.byteOffset + pos)
        )
        indexMap.set(entry.path, entry)
        indexEntries.push(entry)
        pos += calcIndexEntrySize(entry.path, entry.mimeType)
      } catch {
        throw new PackCorruptedError('Invalid index entry at offset ' + pos)
      }
    }

    this.indexMap = indexMap
    this.indexEntries = indexEntries
  }

  async prefetch(entryPaths: string[]): Promise<void> {
    await Promise.all(
      entryPaths.map((path) =>
        this.readEntry(path).catch(() => {})
      )
    )
  }

  getCacheStats(): { size: number; count: number } {
    return { size: this.cache.size, count: this.cache.count }
  }
}
