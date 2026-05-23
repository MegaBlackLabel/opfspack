import { describe, it, expect, beforeAll } from 'vitest'
import {
  MAGIC_NUMBER,
  HEADER_SIZE,
  FORMAT_VERSION,
  LITTLE_ENDIAN,
  PackFlags,
  EntryFlags,
  serializeHeader,
  serializeIndexEntry,
  calcIndexEntrySize,
} from '../format.js'
import {
  deriveMasterKey,
  derivePackKey,
  encryptEntry,
} from '../auth/identity-key.js'
import { deflateSync } from 'fflate'
import { PackReader } from '../reader.js'
import { PackVersionError, PackCorruptedError } from '../errors.js'
import type { PackEntryInfo } from '../types.js'

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

interface TestEntry {
  path: string
  mimeType: string
  data: Uint8Array
  flags?: number
  uncompressedSize?: bigint
}

function buildPackFile(options: {
  version?: number
  entries?: TestEntry[]
  corruptMagic?: boolean
  corruptIndexCrc?: boolean
}): ArrayBuffer {
  const entries = options.entries ?? []
  const version = options.version ?? FORMAT_VERSION

  let dataPos = HEADER_SIZE
  const indexRecords = entries.map((entry) => {
    const size = entry.uncompressedSize ?? BigInt(entry.data.byteLength)
    const record = {
      path: entry.path,
      mimeType: entry.mimeType,
      offset: BigInt(dataPos),
      size,
      compressedSize: BigInt(entry.data.byteLength),
      flags: entry.flags ?? EntryFlags.None,
      iv: new Uint8Array(12),
    }
    dataPos += entry.data.byteLength
    return record
  })

  const indexOffset = BigInt(dataPos)
  let indexEntriesSize = 0
  for (const record of indexRecords) {
    indexEntriesSize += calcIndexEntrySize(record.path, record.mimeType)
  }
  const indexSize = BigInt(indexEntriesSize + 4)

  const headerBuf = serializeHeader({
    magic: MAGIC_NUMBER,
    version,
    flags: PackFlags.None,
    reserved: 0,
    indexOffset,
    indexSize,
    entryCount: entries.length,
    createdAt: BigInt(1700000000000),
    checksum: 0,
  })

  if (options.corruptMagic) {
    new Uint8Array(headerBuf)[0] = 0x00
  }

  const totalSize = dataPos + Number(indexSize)
  const buf = new ArrayBuffer(totalSize)
  const view = new Uint8Array(buf)

  view.set(new Uint8Array(headerBuf), 0)

  let pos = HEADER_SIZE
  for (const entry of entries) {
    view.set(entry.data, pos)
    pos += entry.data.byteLength
  }

  let indexPos = pos
  for (const record of indexRecords) {
    const entryBuf = serializeIndexEntry(record)
    view.set(new Uint8Array(entryBuf), indexPos)
    indexPos += entryBuf.byteLength
  }

  const indexData = view.slice(pos, indexPos)
  const checksum = crc32(indexData)
  const dv = new DataView(buf)
  dv.setUint32(
    indexPos,
    options.corruptIndexCrc ? checksum + 1 : checksum,
    LITTLE_ENDIAN,
  )

  return buf
}

describe('PackReader.fromBuffer', () => {
  it('rejects invalid magic number', () => {
    const buf = buildPackFile({ corruptMagic: true })
    expect(() => PackReader.fromBuffer(buf)).toThrow(PackCorruptedError)
  })

  it('rejects unsupported version', () => {
    const buf = buildPackFile({ version: FORMAT_VERSION + 1 })
    expect(() => PackReader.fromBuffer(buf)).toThrow(PackVersionError)
  })

  it('reads header metadata correctly', () => {
    const buf = buildPackFile({
      entries: [
        {
          path: 'a.txt',
          mimeType: 'text/plain',
          data: new TextEncoder().encode('hello'),
        },
      ],
    })
    const reader = PackReader.fromBuffer(buf)
    const meta = reader.metadata

    expect(meta.version).toBe(FORMAT_VERSION)
    expect(meta.flags).toBe(PackFlags.None)
    expect(meta.entryCount).toBe(1)
    expect(meta.createdAt).toEqual(new Date(1700000000000))
    expect(meta.indexOffset).toBeGreaterThan(BigInt(HEADER_SIZE))
    expect(meta.indexSize).toBeGreaterThan(BigInt(0))
  })
})

describe('PackReader entry access', () => {
  const sampleEntries: TestEntry[] = [
    {
      path: 'README.md',
      mimeType: 'text/markdown',
      data: new TextEncoder().encode('# Hello'),
    },
    {
      path: 'images/cover.jpg',
      mimeType: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    },
  ]

  let reader: PackReader

  beforeAll(() => {
    const buf = buildPackFile({ entries: sampleEntries })
    reader = PackReader.fromBuffer(buf)
  })

  it('hasEntry returns true for existing paths', () => {
    expect(reader.hasEntry('README.md')).toBe(true)
    expect(reader.hasEntry('images/cover.jpg')).toBe(true)
  })

  it('hasEntry returns false for missing paths', () => {
    expect(reader.hasEntry('nonexistent.txt')).toBe(false)
  })

  it('getEntryInfo returns correct info for existing entries', () => {
    const info = reader.getEntryInfo('README.md')
    expect(info).toBeDefined()
    expect(info!.path).toBe('README.md')
    expect(info!.mimeType).toBe('text/markdown')
    expect(info!.size).toBe(7)
    expect(info!.flags).toBe(EntryFlags.None)
  })

  it('getEntryInfo returns undefined for missing entries', () => {
    expect(reader.getEntryInfo('missing')).toBeUndefined()
  })

  it('listEntries returns all entries', () => {
    const list = reader.listEntries()
    expect(list).toHaveLength(2)
    const paths = list.map((e: PackEntryInfo) => e.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('images/cover.jpg')
  })

  it('readEntry returns correct data by path', async () => {
    const data = await reader.readEntry('README.md')
    const text = new TextDecoder().decode(data)
    expect(text).toBe('# Hello')
  })

  it('readEntry returns correct binary data', async () => {
    const data = await reader.readEntry('images/cover.jpg')
    expect(new Uint8Array(data)).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
  })
})

describe('PackReader index validation', () => {
  it('detects corrupted index CRC', () => {
    const buf = buildPackFile({
      entries: [
        {
          path: 'test.txt',
          mimeType: 'text/plain',
          data: new TextEncoder().encode('data'),
        },
      ],
      corruptIndexCrc: true,
    })
    const reader = PackReader.fromBuffer(buf)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })
})

describe('PackReader decompression', () => {
  it('reads compressed entry data', async () => {
    const raw = new TextEncoder().encode('Hello, compressed world!')
    const compressed = deflateSync(raw)

    const buf = buildPackFile({
      entries: [
        {
          path: 'compressed.txt',
          mimeType: 'text/plain',
          data: compressed,
          flags: EntryFlags.Compressed,
          uncompressedSize: BigInt(raw.byteLength),
        },
      ],
    })

    const reader = PackReader.fromBuffer(buf)
    const data = await reader.readEntry('compressed.txt')
    expect(new TextDecoder().decode(data)).toBe('Hello, compressed world!')
  })
})

describe('PackReader fromOPFS', () => {
  it('creates reader from FileSystemFileHandle', async () => {
    const buf = buildPackFile({
      entries: [
        {
          path: 'opfs.txt',
          mimeType: 'text/plain',
          data: new TextEncoder().encode('from opfs'),
        },
      ],
    })

    const mockHandle = {
      kind: 'file' as const,
      name: 'test.pack',
      getFile: async () => new File([buf], 'test.pack'),
      createWritable: async () => ({}),
    } as unknown as FileSystemFileHandle

    const reader = await PackReader.fromOPFS(mockHandle)
    expect(reader.metadata.entryCount).toBe(1)
    expect(reader.hasEntry('opfs.txt')).toBe(true)
  })
})

describe('PackReader identity binding', () => {
  it('decrypts identity-bound entries', async () => {
    const raw = new TextEncoder().encode('Secret content')
    const masterKey = await deriveMasterKey('user-123')
    const packKey = await derivePackKey(masterKey, 'pack-abc')
    const rawBuf = new ArrayBuffer(raw.byteLength)
    new Uint8Array(rawBuf).set(raw)
    const { encrypted, iv } = await encryptEntry(rawBuf, packKey)

    const entry: TestEntry = {
      path: 'secret.txt',
      mimeType: 'text/plain',
      data: new Uint8Array(encrypted),
      flags: EntryFlags.IdentityBound,
    }

    let buf = buildPackFile({ entries: [entry] })

    const indexOffset = Number(new DataView(buf).getBigUint64(16, LITTLE_ENDIAN))
    const indexSize = Number(new DataView(buf).getBigUint64(24, LITTLE_ENDIAN))
    const pathBytes = new TextEncoder().encode(entry.path).byteLength
    const mimeBytes = new TextEncoder().encode(entry.mimeType).byteLength
    const ivOffset = indexOffset + 2 + pathBytes + 2 + mimeBytes + 8 + 8 + 8 + 4
    new Uint8Array(buf).set(iv, ivOffset)

    const indexData = new Uint8Array(buf, indexOffset, indexSize - 4)
    const newCrc = crc32(indexData)
    new DataView(buf).setUint32(indexOffset + indexSize - 4, newCrc, LITTLE_ENDIAN)

    const reader = PackReader.fromBuffer(buf)
    const data = await reader.readEntry('secret.txt', {
      identitySub: 'user-123',
      packId: 'pack-abc',
    })
    expect(new TextDecoder().decode(data)).toBe('Secret content')
  })
})

describe('PackReader readEntryRange', () => {
  it('reads a subrange of an entry', async () => {
    const buf = buildPackFile({
      entries: [
        {
          path: 'range.txt',
          mimeType: 'text/plain',
          data: new TextEncoder().encode('ABCDEFGHIJ'),
        },
      ],
    })
    const reader = PackReader.fromBuffer(buf)
    const data = await reader.readEntryRange('range.txt', 2, 6)
    expect(new TextDecoder().decode(data)).toBe('CDEF')
  })
})

describe('PackReader close', () => {
  it('makes reader unusable after close', () => {
    const buf = buildPackFile({
      entries: [
        {
          path: 'close.txt',
          mimeType: 'text/plain',
          data: new TextEncoder().encode('data'),
        },
      ],
    })
    const reader = PackReader.fromBuffer(buf)
    reader.close()
    expect(() => reader.metadata).toThrow('closed')
    expect(() => reader.hasEntry('close.txt')).toThrow('closed')
    expect(() => reader.listEntries()).toThrow('closed')
  })
})
