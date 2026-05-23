import { deflateSync } from 'fflate'
import {
  HEADER_SIZE,
  MAGIC_NUMBER,
  PackFlags,
  EntryFlags,
  FORMAT_VERSION,
  serializeHeader,
  serializeIndexEntry,
  calcIndexEntrySize,
  crc32,
} from './format.js'
import { deriveMasterKey, derivePackKey, encryptEntry } from './auth/identity-key.js'
import { generateIV } from './wasm-bridge.js'

export interface PackBuilderOptions {
  createdAt?: bigint
  compress?: boolean
  compressionLevel?: number
  identityBinding?: boolean
  sub?: string
  packId?: string
  onProgress?: (progress: {
    phase: 'scanning' | 'packing' | 'indexing' | 'finalizing'
    current: number
    total: number
    bytesProcessed: number
    bytesTotal: number
  }) => void
}

interface BuilderEntry {
  path: string
  mimeType: string
  data: Uint8Array
  options?: { compress?: boolean }
}

interface ProcessedEntry {
  path: string
  mimeType: string
  data: Uint8Array
  originalSize: number
  compressedSize: number
  flags: number
  iv: Uint8Array
}

function align8(n: number): number {
  return Math.ceil(n / 8) * 8
}

export class PackBuilder {
  private entries: BuilderEntry[] = []
  private options: Required<Pick<PackBuilderOptions, 'createdAt' | 'compress' | 'identityBinding'>> &
    Pick<PackBuilderOptions, 'compressionLevel' | 'sub' | 'packId' | 'onProgress'>

  constructor(options: PackBuilderOptions = {}) {
    let compressionLevel = options.compressionLevel
    if (compressionLevel !== undefined) {
      if (!Number.isFinite(compressionLevel)) {
        compressionLevel = undefined
      } else {
        compressionLevel = Math.max(0, Math.min(9, Math.trunc(compressionLevel)))
      }
    }

    this.options = {
      createdAt: options.createdAt ?? BigInt(Date.now()),
      compress: options.compress ?? false,
      identityBinding: options.identityBinding ?? false,
      compressionLevel,
      sub: options.sub,
      packId: options.packId,
      onProgress: options.onProgress,
    }
  }

  addEntry(
    path: string,
    data: Uint8Array | ArrayBuffer,
    mimeType: string,
    options?: { compress?: boolean },
  ): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.entries.push({ path, mimeType, data: bytes, options })
  }

  private emitProgress(
    phase: 'scanning' | 'packing' | 'indexing' | 'finalizing',
    current: number,
    total: number,
    bytesProcessed: number,
    bytesTotal: number
  ) {
    if (this.options.onProgress) {
      this.options.onProgress({ phase, current, total, bytesProcessed, bytesTotal })
    }
  }

  private async processEntries(): Promise<ProcessedEntry[]> {
    const processed: ProcessedEntry[] = []

    // Sort entries by path for deterministic index order
    // Use code-point comparison for locale-independent ordering
    const sortedEntries = [...this.entries].sort((a, b) => {
      if (a.path < b.path) return -1
      if (a.path > b.path) return 1
      return 0
    })

    let packKey: CryptoKey | undefined
    
    if (this.options.identityBinding && this.options.sub && this.options.packId) {
      const masterKey = await deriveMasterKey(this.options.sub)
      packKey = await derivePackKey(masterKey, this.options.packId)
    }

    let bytesProcessed = 0
    const bytesTotal = sortedEntries.reduce((sum, e) => sum + e.data.byteLength, 0)

    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i]
      let data = entry.data
      let compressedSize = 0
      let flags = EntryFlags.None
      let iv: Uint8Array = new Uint8Array(12)

      const shouldCompress = entry.options?.compress ?? this.options.compress

      if (shouldCompress) {
        const level = (this.options.compressionLevel ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
        const compressed = deflateSync(data, { level })
        data = compressed
        compressedSize = compressed.byteLength
        flags |= EntryFlags.Compressed
      }

      if (this.options.identityBinding && packKey) {
        const dataCopy = new Uint8Array(data.byteLength)
        dataCopy.set(data)
        
        iv = await generateIV()
        const { encrypted, iv: entryIv } = await encryptEntry(dataCopy.buffer, packKey)
        data = new Uint8Array(encrypted)
        iv = new Uint8Array(entryIv)
        
        flags |= EntryFlags.Encrypted | EntryFlags.IdentityBound
        compressedSize = data.byteLength
      }

      if (compressedSize === 0) {
        compressedSize = data.byteLength
      }

      processed.push({
        path: entry.path,
        mimeType: entry.mimeType,
        data,
        originalSize: entry.data.byteLength,
        compressedSize,
        flags,
        iv,
      })

      bytesProcessed += entry.data.byteLength
      this.emitProgress('packing', i + 1, sortedEntries.length, bytesProcessed, bytesTotal)
    }

    return processed
  }

  private calculateOffsets(processed: ProcessedEntry[]): {
    entryOffsets: number[]
    indexOffset: number
    indexSize: number
    packFlags: number
  } {
    let currentOffset = HEADER_SIZE
    const entryOffsets: number[] = []
    for (const entry of processed) {
      entryOffsets.push(currentOffset)
      currentOffset += align8(entry.data.byteLength)
    }

    const indexOffset = currentOffset
    let indexSize = 0
    for (const entry of processed) {
      indexSize += calcIndexEntrySize(entry.path, entry.mimeType)
    }
    indexSize += 4

    let packFlags = PackFlags.None
    if (this.options.compress) {
      packFlags |= PackFlags.Compressed
    }
    if (this.options.identityBinding) {
      packFlags |= PackFlags.Encrypted
    }

    return { entryOffsets, indexOffset, indexSize, packFlags }
  }

  async build(): Promise<ArrayBuffer> {
    const bytesTotal = this.entries.reduce((sum, e) => sum + e.data.byteLength, 0)
    this.emitProgress('scanning', 0, this.entries.length, 0, bytesTotal)
    
    const processed = await this.processEntries()
    const { entryOffsets, indexOffset, indexSize, packFlags } = this.calculateOffsets(processed)

    const header = serializeHeader({
      magic: MAGIC_NUMBER,
      version: FORMAT_VERSION,
      flags: packFlags,
      reserved: 0,
      indexOffset: BigInt(indexOffset),
      indexSize: BigInt(indexSize),
      entryCount: processed.length,
      createdAt: this.options.createdAt,
      checksum: 0,
    })

    const totalSize = indexOffset + indexSize
    const pack = new ArrayBuffer(totalSize)
    const packView = new Uint8Array(pack)

    packView.set(new Uint8Array(header), 0)

    for (let i = 0; i < processed.length; i++) {
      const entry = processed[i]
      packView.set(entry.data, entryOffsets[i])
    }

    let indexPos = indexOffset
    for (let i = 0; i < processed.length; i++) {
      const entry = processed[i]
      const indexEntry = serializeIndexEntry({
        path: entry.path,
        mimeType: entry.mimeType,
        offset: BigInt(entryOffsets[i]),
        size: BigInt(entry.originalSize),
        compressedSize: BigInt(entry.compressedSize),
        flags: entry.flags,
        iv: entry.iv,
      })
      packView.set(new Uint8Array(indexEntry), indexPos)
      indexPos += indexEntry.byteLength
    }

    const indexData = packView.slice(indexOffset, indexPos)
    const indexCrc = crc32(indexData)
    const dv = new DataView(pack)
    dv.setUint32(indexPos, indexCrc, true)

    this.emitProgress('indexing', processed.length, processed.length, bytesTotal, bytesTotal)
    this.emitProgress('finalizing', processed.length, processed.length, bytesTotal, bytesTotal)

    return pack
  }

  async buildToOPFS(fileHandle: FileSystemFileHandle): Promise<void> {
    const writable = await fileHandle.createWritable()
    try {
      const bytesTotal = this.entries.reduce((sum, e) => sum + e.data.byteLength, 0)
      this.emitProgress('scanning', 0, this.entries.length, 0, bytesTotal)
      
      const processed = await this.processEntries()
      const { entryOffsets, indexOffset, indexSize, packFlags } = this.calculateOffsets(processed)

      const header = serializeHeader({
        magic: MAGIC_NUMBER,
        version: FORMAT_VERSION,
        flags: packFlags,
        reserved: 0,
        indexOffset: BigInt(indexOffset),
        indexSize: BigInt(indexSize),
        entryCount: processed.length,
        createdAt: this.options.createdAt,
        checksum: 0,
      })

      await writable.write(header)

      for (let i = 0; i < processed.length; i++) {
        const entry = processed[i]
        const alignedSize = align8(entry.data.byteLength)
        const padded = new Uint8Array(alignedSize)
        padded.set(entry.data)
        await writable.write(padded)
      }

      let indexData = new Uint8Array(0)
      for (let i = 0; i < processed.length; i++) {
        const entry = processed[i]
        const indexEntry = serializeIndexEntry({
          path: entry.path,
          mimeType: entry.mimeType,
          offset: BigInt(entryOffsets[i]),
          size: BigInt(entry.originalSize),
          compressedSize: BigInt(entry.compressedSize),
          flags: entry.flags,
          iv: entry.iv,
        })
        await writable.write(indexEntry)
        const entryBytes = new Uint8Array(indexEntry)
        const combined = new Uint8Array(indexData.byteLength + entryBytes.byteLength)
        combined.set(indexData)
        combined.set(entryBytes, indexData.byteLength)
        indexData = combined
      }

      const indexCrc = crc32(indexData)
      const crcBuf = new ArrayBuffer(4)
      new DataView(crcBuf).setUint32(0, indexCrc, true)
      await writable.write(crcBuf)

      await writable.seek(0)
      await writable.write(header)

      this.emitProgress('indexing', processed.length, processed.length, bytesTotal, bytesTotal)
      this.emitProgress('finalizing', processed.length, processed.length, bytesTotal, bytesTotal)
    } finally {
      await writable.close()
    }
  }
}
