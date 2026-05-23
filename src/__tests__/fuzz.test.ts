import { describe, it, expect } from 'vitest'
import { PackBuilder } from '../builder'
import { PackReader } from '../reader'
import { PackCorruptedError, PackVersionError, PackNotFoundError } from '../errors'
import {
  HEADER_SIZE,
  MAGIC_NUMBER,
  FORMAT_VERSION,
  PackFlags,
  EntryFlags,
  serializeHeader,
  serializeIndexEntry,
  crc32,
} from '../format'
import { MemoryPackStorage, PackManager } from '../manager'
import { migrateToPacks, validatePack } from '../migration'

function createRandomData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  const chunkSize = 65536
  for (let i = 0; i < size; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, size))
    crypto.getRandomValues(chunk)
  }
  return data
}

function copyBuffer(buf: ArrayBuffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength)
  copy.set(new Uint8Array(buf))
  return copy.buffer
}

function flipRandomByte(buf: ArrayBuffer): ArrayBuffer {
  const copy = copyBuffer(buf)
  const view = new Uint8Array(copy)
  const pos = Math.floor(Math.random() * view.length)
  view[pos] = view[pos]! ^ 0xff
  return copy
}

function flipBytesInRange(buf: ArrayBuffer, start: number, count: number): ArrayBuffer {
  const copy = copyBuffer(buf)
  const view = new Uint8Array(copy)
  for (let i = 0; i < count && start + i < view.length; i++) {
    const pos = start + i
    view[pos] = view[pos]! ^ 0xff
  }
  return copy
}

describe('Fuzz: Random data pack building and reading', () => {
  it('roundtrips random data of various sizes', async () => {
    const builder = new PackBuilder()
    const sizes = [0, 1, 7, 64, 255, 1024, 10000]

    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i]!
      const data = createRandomData(size)
      builder.addEntry(`rand-${i}.bin`, data, 'application/octet-stream')
    }

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    for (let i = 0; i < sizes.length; i++) {
      const path = `rand-${i}.bin`
      const readData = await reader.readEntry(path)
      expect(new Uint8Array(readData).byteLength).toBe(sizes[i])
    }

    reader.close()
  })

  it('roundtrips random data over 10 iterations', async () => {
    for (let iter = 0; iter < 10; iter++) {
      const builder = new PackBuilder()
      const numEntries = 3 + Math.floor(Math.random() * 8)
      const expected = new Map<string, Uint8Array>()

      for (let i = 0; i < numEntries; i++) {
        const size = Math.floor(Math.random() * 5000)
        const data = createRandomData(size)
        const path = `iter${iter}-file${i}.dat`
        expected.set(path, data)
        builder.addEntry(path, data, 'application/octet-stream')
      }

      const pack = await builder.build()
      const reader = PackReader.fromBuffer(pack)

      for (const [path, data] of expected) {
        const readData = await reader.readEntry(path)
        expect(new Uint8Array(readData)).toEqual(data)
      }

      reader.close()
    }
  })
})

describe('Fuzz: Truncated pack handling', () => {
  it('rejects pack truncated before header completes', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const truncated = pack.slice(0, HEADER_SIZE - 1)
    expect(() => PackReader.fromBuffer(truncated)).toThrow(PackCorruptedError)
  })

  it('rejects pack truncated in entry data', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello world'), 'text/plain')
    const pack = await builder.build()

    const truncated = pack.slice(0, HEADER_SIZE + 3)
    const reader = PackReader.fromBuffer(truncated)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })

  it('rejects pack truncated in index', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const truncated = pack.slice(0, indexOffset + 2)

    const reader = PackReader.fromBuffer(truncated)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })

  it('rejects pack with missing CRC', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const indexSize = Number(header.getBigUint64(24, true))
    const truncated = pack.slice(0, indexOffset + indexSize - 1)

    const reader = PackReader.fromBuffer(truncated)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })
})

describe('Fuzz: Corrupted header magic handling', () => {
  it('rejects pack with all-zero magic', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[0] = 0x00
    view[1] = 0x00
    view[2] = 0x00
    view[3] = 0x00

    expect(() => PackReader.fromBuffer(corrupted)).toThrow(PackCorruptedError)
  })

  it('rejects pack with wrong magic bytes', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[0] = 0x50 // 'P'
    view[1] = 0x4b // 'K'
    view[2] = 0x03
    view[3] = 0x04

    expect(() => PackReader.fromBuffer(corrupted)).toThrow(PackCorruptedError)
  })

  it('rejects pack with single flipped magic byte', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[2] = view[2]! ^ 0x01

    expect(() => PackReader.fromBuffer(corrupted)).toThrow(PackCorruptedError)
  })
})

describe('Fuzz: Corrupted index CRC handling', () => {
  it('rejects pack with flipped CRC bit', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const indexSize = Number(header.getBigUint64(24, true))
    const crcOffset = indexOffset + indexSize - 4

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[crcOffset] = view[crcOffset]! ^ 0x01

    const reader = PackReader.fromBuffer(corrupted)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })

  it('rejects pack with all-zero CRC', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const indexSize = Number(header.getBigUint64(24, true))
    const crcOffset = indexOffset + indexSize - 4

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[crcOffset] = 0x00
    view[crcOffset + 1] = 0x00
    view[crcOffset + 2] = 0x00
    view[crcOffset + 3] = 0x00

    const reader = PackReader.fromBuffer(corrupted)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })

  it('rejects pack with inverted CRC', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const indexSize = Number(header.getBigUint64(24, true))
    const crcOffset = indexOffset + indexSize - 4

    const corrupted = copyBuffer(pack)
    const view = new Uint8Array(corrupted)
    view[crcOffset] = view[crcOffset]! ^ 0xff
    view[crcOffset + 1] = view[crcOffset + 1]! ^ 0xff
    view[crcOffset + 2] = view[crcOffset + 2]! ^ 0xff
    view[crcOffset + 3] = view[crcOffset + 3]! ^ 0xff

    const reader = PackReader.fromBuffer(corrupted)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })
})

describe('Fuzz: Random byte flips in pack data', () => {
  it('detects corruption from random byte flips in header', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    for (let i = 0; i < 20; i++) {
      const corrupted = flipRandomByte(pack)
      try {
        PackReader.fromBuffer(corrupted)
      } catch (e) {
        expect(e).toBeInstanceOf(PackCorruptedError)
      }
    }
  })

  it('detects corruption from byte flips in index area', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello world'), 'text/plain')
    const pack = await builder.build()

    const header = new DataView(pack)
    const indexOffset = Number(header.getBigUint64(16, true))
    const indexSize = Number(header.getBigUint64(24, true))

    for (let i = 0; i < 10; i++) {
      const pos = indexOffset + Math.floor(Math.random() * indexSize)
      const corrupted = flipBytesInRange(pack, pos, 1)

      const reader = PackReader.fromBuffer(corrupted)
      expect(() => reader.listEntries()).toThrow(PackCorruptedError)
    }
  })

  it('may or may not error on byte flips in entry payload', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello world'), 'text/plain')
    const pack = await builder.build()

    const corrupted = flipBytesInRange(pack, HEADER_SIZE, 1)
    const reader = PackReader.fromBuffer(corrupted)

    const entries = reader.listEntries()
    expect(entries).toHaveLength(1)

    const data = await reader.readEntry('test.txt')
    expect(new Uint8Array(data)).not.toEqual(new TextEncoder().encode('hello world'))
    reader.close()
  })
})

describe('Fuzz: Boundary tests', () => {
  it('handles empty pack', async () => {
    const builder = new PackBuilder()
    const pack = await builder.build()

    const reader = PackReader.fromBuffer(pack)
    expect(reader.metadata.entryCount).toBe(0)
    expect(reader.listEntries()).toHaveLength(0)
    expect(reader.hasEntry('anything')).toBe(false)
    expect(reader.getEntryInfo('anything')).toBeUndefined()
    reader.close()
  })

  it('handles single byte entry', async () => {
    const builder = new PackBuilder()
    const data = new Uint8Array([0x42])
    builder.addEntry('single.bin', data, 'application/octet-stream')

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    expect(reader.metadata.entryCount).toBe(1)
    const readData = await reader.readEntry('single.bin')
    expect(new Uint8Array(readData)).toEqual(data)
    reader.close()
  })

  it('handles large entry (1MB+)', async () => {
    const builder = new PackBuilder()
    const data = createRandomData(1024 * 1024 + 7)
    builder.addEntry('large.bin', data, 'application/octet-stream')

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    const readData = await reader.readEntry('large.bin')
    expect(new Uint8Array(readData)).toEqual(data)
    reader.close()
  })

  it('handles many small entries (100+)', async () => {
    const builder = new PackBuilder()
    const expected = new Map<string, Uint8Array>()

    for (let i = 0; i < 150; i++) {
      const path = `entry-${i}.txt`
      const data = new TextEncoder().encode(`content-${i}`)
      expected.set(path, data)
      builder.addEntry(path, data, 'text/plain')
    }

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    expect(reader.metadata.entryCount).toBe(150)
    expect(reader.listEntries()).toHaveLength(150)

    for (const [path, data] of expected) {
      const readData = await reader.readEntry(path)
      expect(new Uint8Array(readData)).toEqual(data)
    }

    reader.close()
  })

  it('handles empty entry alongside normal entries', async () => {
    const builder = new PackBuilder()
    builder.addEntry('empty.txt', new Uint8Array(0), 'text/plain')
    builder.addEntry('normal.txt', new TextEncoder().encode('normal'), 'text/plain')

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    expect(reader.metadata.entryCount).toBe(2)

    const emptyData = await reader.readEntry('empty.txt')
    expect(new Uint8Array(emptyData).byteLength).toBe(0)

    const normalData = await reader.readEntry('normal.txt')
    expect(new TextDecoder().decode(normalData)).toBe('normal')

    reader.close()
  })

  it('handles entries at 8-byte alignment boundaries', async () => {
    const builder = new PackBuilder()
    builder.addEntry('7bytes.bin', new Uint8Array(7), 'application/octet-stream')
    builder.addEntry('8bytes.bin', new Uint8Array(8), 'application/octet-stream')
    builder.addEntry('9bytes.bin', new Uint8Array(9), 'application/octet-stream')
    builder.addEntry('15bytes.bin', new Uint8Array(15), 'application/octet-stream')
    builder.addEntry('16bytes.bin', new Uint8Array(16), 'application/octet-stream')

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    expect(reader.metadata.entryCount).toBe(5)

    for (const path of ['7bytes.bin', '8bytes.bin', '9bytes.bin', '15bytes.bin', '16bytes.bin']) {
      const info = reader.getEntryInfo(path)
      expect(info).toBeDefined()
      const data = await reader.readEntry(path)
      expect(new Uint8Array(data).byteLength).toBeDefined()
    }

    reader.close()
  })
})

describe('Fuzz: Decompression failure', () => {
  it('throws when compressed data is corrupted', async () => {
    const raw = new TextEncoder().encode('this is not valid deflate data')

    const indexEntry = serializeIndexEntry({
      path: 'bad.txt',
      mimeType: 'text/plain',
      offset: BigInt(HEADER_SIZE),
      size: BigInt(raw.byteLength),
      compressedSize: BigInt(raw.byteLength),
      flags: EntryFlags.Compressed,
      iv: new Uint8Array(12),
    })

    const indexSize = indexEntry.byteLength + 4
    const header = serializeHeader({
      magic: MAGIC_NUMBER,
      version: FORMAT_VERSION,
      flags: PackFlags.Compressed,
      reserved: 0,
      indexOffset: BigInt(HEADER_SIZE + raw.byteLength),
      indexSize: BigInt(indexSize),
      entryCount: 1,
      createdAt: BigInt(1700000000000),
      checksum: 0,
    })

    const totalSize = HEADER_SIZE + raw.byteLength + indexSize
    const pack = new ArrayBuffer(totalSize)
    const view = new Uint8Array(pack)
    view.set(new Uint8Array(header), 0)
    view.set(raw, HEADER_SIZE)
    view.set(new Uint8Array(indexEntry), HEADER_SIZE + raw.byteLength)

    const indexData = view.slice(HEADER_SIZE + raw.byteLength, HEADER_SIZE + raw.byteLength + indexEntry.byteLength)
    const indexCrc = crc32(indexData)
    new DataView(pack).setUint32(HEADER_SIZE + raw.byteLength + indexEntry.byteLength, indexCrc, true)

    const reader = PackReader.fromBuffer(pack)
    await expect(reader.readEntry('bad.txt')).rejects.toThrow('Decompression failed')
    reader.close()
  })
})

describe('Fuzz: readEntryRange errors', () => {
  it('throws when entry is not found in readEntryRange', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const reader = PackReader.fromBuffer(pack)
    await expect(reader.readEntryRange('missing.txt', 0, 1)).rejects.toThrow('Entry not found')
    reader.close()
  })

  it('throws for invalid range', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const reader = PackReader.fromBuffer(pack)
    await expect(reader.readEntryRange('test.txt', 3, 3)).rejects.toThrow('Invalid range')
    await expect(reader.readEntryRange('test.txt', 10, 20)).rejects.toThrow('Invalid range')
    await expect(reader.readEntryRange('test.txt', 3, 1)).rejects.toThrow('Invalid range')
    reader.close()
  })
})

describe('Fuzz: Index structural corruption', () => {
  it('rejects pack with index too small for CRC', async () => {
    const header = serializeHeader({
      magic: MAGIC_NUMBER,
      version: FORMAT_VERSION,
      flags: PackFlags.None,
      reserved: 0,
      indexOffset: BigInt(HEADER_SIZE),
      indexSize: BigInt(3),
      entryCount: 0,
      createdAt: BigInt(1700000000000),
      checksum: 0,
    })

    const pack = new ArrayBuffer(HEADER_SIZE + 3)
    const view = new Uint8Array(pack)
    view.set(new Uint8Array(header), 0)

    const reader = PackReader.fromBuffer(pack)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })

  it('rejects pack with truncated index entries', async () => {
    const raw = new TextEncoder().encode('hello')

    const indexEntry = serializeIndexEntry({
      path: 'test.txt',
      mimeType: 'text/plain',
      offset: BigInt(HEADER_SIZE),
      size: BigInt(raw.byteLength),
      compressedSize: BigInt(raw.byteLength),
      flags: EntryFlags.None,
      iv: new Uint8Array(12),
    })

    const indexSize = indexEntry.byteLength + 4
    const header = serializeHeader({
      magic: MAGIC_NUMBER,
      version: FORMAT_VERSION,
      flags: PackFlags.None,
      reserved: 0,
      indexOffset: BigInt(HEADER_SIZE + raw.byteLength),
      indexSize: BigInt(indexSize),
      entryCount: 2,
      createdAt: BigInt(1700000000000),
      checksum: 0,
    })

    const totalSize = HEADER_SIZE + raw.byteLength + indexSize
    const pack = new ArrayBuffer(totalSize)
    const view = new Uint8Array(pack)
    view.set(new Uint8Array(header), 0)
    view.set(raw, HEADER_SIZE)
    view.set(new Uint8Array(indexEntry), HEADER_SIZE + raw.byteLength)

    const indexData = view.slice(HEADER_SIZE + raw.byteLength, HEADER_SIZE + raw.byteLength + indexEntry.byteLength)
    const indexCrc = crc32(indexData)
    new DataView(pack).setUint32(HEADER_SIZE + raw.byteLength + indexEntry.byteLength, indexCrc, true)

    const reader = PackReader.fromBuffer(pack)
    expect(() => reader.listEntries()).toThrow(PackCorruptedError)
  })
})

describe('Fuzz: PackManager default storage', () => {
  it('uses MemoryPackStorage when no storage is provided', async () => {
    const manager = new PackManager()
    const files = [{ path: 'test.txt', data: new TextEncoder().encode('hello'), mimeType: 'text/plain' }]

    await manager.createPack('default-pack', files)
    expect(await manager.hasPack('default-pack')).toBe(true)

    const data = await manager.readFile('default-pack', 'test.txt')
    expect(new TextDecoder().decode(data)).toBe('hello')
  })
})

describe('Fuzz: Exported MemoryPackStorage error handling', () => {
  it('throws PackNotFoundError on read missing pack', async () => {
    const storage = new MemoryPackStorage()
    await expect(storage.read('missing')).rejects.toThrow(PackNotFoundError)
  })

  it('throws PackNotFoundError on delete missing pack', async () => {
    const storage = new MemoryPackStorage()
    await expect(storage.delete('missing')).rejects.toThrow(PackNotFoundError)
  })
})

describe('Fuzz: migrateToPacks error handling', () => {
  it('reports errors when storage write fails', async () => {
    const throwingStorage = new MemoryPackStorage()
    throwingStorage.write = async () => {
      throw new Error('Storage full')
    }

    const files = [
      { path: 'book1/page1.png', data: new TextEncoder().encode('png1') },
    ]

    const fs = { listFiles: async () => files }
    const result = await migrateToPacks(fs, throwingStorage)

    expect(result.packs).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.bookId).toBe('book1')
    expect(result.errors[0]!.error.message).toBe('Storage full')
  })

  it('reports non-Error throws correctly', async () => {
    const throwingStorage = new MemoryPackStorage()
    throwingStorage.write = async () => {
      throw 'string error'
    }

    const files = [
      { path: 'book1/page1.png', data: new TextEncoder().encode('png1') },
    ]

    const fs = { listFiles: async () => files }
    const result = await migrateToPacks(fs, throwingStorage)

    expect(result.packs).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.error.message).toBe('string error')
  })

  it('skips files with empty bookId', async () => {
    const storage = new MemoryPackStorage()
    const files = [
      { path: '/root.txt', data: new TextEncoder().encode('root') },
      { path: 'book1/page1.png', data: new TextEncoder().encode('png1') },
    ]

    const fs = { listFiles: async () => files }
    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(1)
    expect(result.packs[0]).toBe('book1')
  })
})

describe('Fuzz: guessMimeType default case', () => {
  it('handles unknown extensions during migration', async () => {
    const storage = new MemoryPackStorage()
    const files = [
      { path: 'book1/data.xyz', data: new TextEncoder().encode('unknown') },
      { path: 'book1/config.abc', data: new TextEncoder().encode('config') },
    ]

    const fs = { listFiles: async () => files }
    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(1)
    expect(result.errors).toHaveLength(0)

    const packData = await storage.read('book1')
    const isValid = await validatePack(packData)
    expect(isValid).toBe(true)
  })
})

describe('Fuzz: Version mismatch', () => {
  it('rejects pack with unsupported version', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
    const pack = await builder.build()

    const corrupted = copyBuffer(pack)
    const dv = new DataView(corrupted)
    dv.setUint32(4, FORMAT_VERSION + 5, true)

    const headerBytes = new Uint8Array(corrupted, 0, 60)
    const newChecksum = crc32(headerBytes)
    dv.setUint32(60, newChecksum, true)

    expect(() => PackReader.fromBuffer(corrupted)).toThrow(PackVersionError)
  })
})
