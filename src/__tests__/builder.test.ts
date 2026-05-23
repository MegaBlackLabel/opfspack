import { describe, it, expect, vi } from 'vitest'
import { PackBuilder } from '../builder'
import {
  deserializeHeader,
  deserializeIndexEntry,
  HEADER_SIZE,
  validateMagic,
  PackFlags,
  EntryFlags,
  calcIndexEntrySize,
} from '../format.js'

function align8(n: number): number {
  return Math.ceil(n / 8) * 8
}

function readEntryData(pack: ArrayBuffer, offset: bigint, size: bigint): Uint8Array {
  return new Uint8Array(pack, Number(offset), Number(size))
}

function createMockFileHandle() {
  const buffer = new Uint8Array(10 * 1024 * 1024)
  let position = 0
  let maxPosition = 0

  const writable = {
    write: vi.fn(async (data: ArrayBuffer | ArrayBufferView) => {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      buffer.set(bytes, position)
      position += bytes.byteLength
      if (position > maxPosition) maxPosition = position
    }),
    seek: vi.fn(async (pos: number) => {
      position = pos
    }),
    close: vi.fn(async () => {}),
  }

  const fileHandle = {
    createWritable: vi.fn(async () => writable),
  } as unknown as FileSystemFileHandle

  return {
    fileHandle,
    writable,
    getWrittenBuffer: () => buffer.slice(0, maxPosition).buffer,
  }
}

describe('PackBuilder', () => {
  const MOCK_TIME = BigInt(1700000000000)

  describe('empty pack', () => {
    it('creates empty pack with valid header', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const pack = await builder.build()

      expect(pack.byteLength).toBe(HEADER_SIZE + 4)

      const header = deserializeHeader(pack)
      expect(validateMagic(header.magic)).toBe(true)
      expect(header.version).toBe(2)
      expect(header.flags).toBe(PackFlags.None)
      expect(header.entryCount).toBe(0)
      expect(header.indexOffset).toBe(BigInt(HEADER_SIZE))
      expect(header.indexSize).toBe(BigInt(4))
      expect(header.createdAt).toBe(MOCK_TIME)
      expect(header.checksum).toBeGreaterThan(0)
    })
  })

  describe('single entry', () => {
    it('adds single entry and builds correct pack', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const data = new TextEncoder().encode('hello world')
      builder.addEntry('test.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.entryCount).toBe(1)
      expect(header.indexOffset).toBeGreaterThan(BigInt(HEADER_SIZE))
      expect(header.indexSize).toBeGreaterThan(BigInt(0))

      const entryData = readEntryData(pack, BigInt(HEADER_SIZE), BigInt(data.byteLength))
      expect(new TextDecoder().decode(entryData)).toBe('hello world')

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)
      expect(entry.path).toBe('test.txt')
      expect(entry.mimeType).toBe('text/plain')
      expect(entry.offset).toBe(BigInt(HEADER_SIZE))
      expect(entry.size).toBe(BigInt(data.byteLength))
      expect(entry.compressedSize).toBe(BigInt(data.byteLength))
      expect(entry.flags).toBe(EntryFlags.None)
      expect(entry.iv).toEqual(new Uint8Array(12))
    })

    it('entry data is 8-byte aligned', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const data = new TextEncoder().encode('hello')
      builder.addEntry('test.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.indexOffset).toBe(BigInt(HEADER_SIZE + align8(data.byteLength)))
    })
  })

  describe('multiple entries', () => {
    it('calculates correct offsets for multiple entries', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const data1 = new TextEncoder().encode('first')
      const data2 = new TextEncoder().encode('second-content')
      builder.addEntry('a.txt', data1, 'text/plain')
      builder.addEntry('b.txt', data2, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.entryCount).toBe(2)

      const indexOffset = Number(header.indexOffset)
      const indexSize = Number(header.indexSize)
      const indexBuf = pack.slice(indexOffset, indexOffset + indexSize)

      const entry1 = deserializeIndexEntry(indexBuf)
      expect(entry1.path).toBe('a.txt')
      expect(entry1.offset).toBe(BigInt(HEADER_SIZE))
      expect(entry1.size).toBe(BigInt(data1.byteLength))

      const entry1Size = calcIndexEntrySize('a.txt', 'text/plain')
      const entry2Buf = indexBuf.slice(entry1Size)
      const entry2 = deserializeIndexEntry(entry2Buf)
      expect(entry2.path).toBe('b.txt')
      expect(entry2.offset).toBe(BigInt(HEADER_SIZE + align8(data1.byteLength)))
      expect(entry2.size).toBe(BigInt(data2.byteLength))
    })

    it('entry data is sequential with 8-byte alignment', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('a.txt', new TextEncoder().encode('a'), 'text/plain')
      builder.addEntry('b.txt', new TextEncoder().encode('bb'), 'text/plain')
      builder.addEntry('c.txt', new TextEncoder().encode('ccc'), 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))

      const entry1 = deserializeIndexEntry(indexBuf)
      expect(entry1.offset).toBe(BigInt(HEADER_SIZE))

      const entry1IndexSize = calcIndexEntrySize('a.txt', 'text/plain')
      const entry2 = deserializeIndexEntry(indexBuf.slice(entry1IndexSize))
      expect(entry2.offset).toBe(BigInt(HEADER_SIZE + align8(1)))

      const entry2IndexSize = calcIndexEntrySize('b.txt', 'text/plain')
      const entry3 = deserializeIndexEntry(indexBuf.slice(entry1IndexSize + entry2IndexSize))
      expect(entry3.offset).toBe(BigInt(HEADER_SIZE + align8(1) + align8(2)))
    })
  })

  describe('UTF-8 paths', () => {
    it('handles UTF-8 paths correctly', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const path = '画像/表紙.jpg'
      const data = new TextEncoder().encode('fake image data')
      builder.addEntry(path, data, 'image/jpeg')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.path).toBe(path)
      expect(entry.mimeType).toBe('image/jpeg')
    })

    it('handles emoji in paths', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const path = '📚/books/日本語.txt'
      const data = new TextEncoder().encode('content')
      builder.addEntry(path, data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.path).toBe(path)
    })
  })

  describe('deterministic output', () => {
    it('produces identical output for identical inputs', async () => {
      const builder1 = new PackBuilder({ createdAt: MOCK_TIME })
      builder1.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      builder1.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      const pack1 = new Uint8Array(await builder1.build())

      const builder2 = new PackBuilder({ createdAt: MOCK_TIME })
      builder2.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      builder2.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      const pack2 = new Uint8Array(await builder2.build())

      expect(pack1).toEqual(pack2)
    })

    it('produces deterministic output regardless of entry order', async () => {
      const builder1 = new PackBuilder({ createdAt: MOCK_TIME })
      builder1.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      builder1.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      const pack1 = new Uint8Array(await builder1.build())

      const builder2 = new PackBuilder({ createdAt: MOCK_TIME })
      builder2.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      builder2.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      const pack2 = new Uint8Array(await builder2.build())

      expect(pack1).toEqual(pack2)
    })
  })

  describe('compression', () => {
    it('compresses entry when compression is enabled', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME, compress: true })
      const data = new TextEncoder().encode('a'.repeat(1000))
      builder.addEntry('big.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.flags & PackFlags.Compressed).toBeTruthy()

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.flags & EntryFlags.Compressed).toBeTruthy()
      expect(entry.compressedSize).toBeGreaterThan(BigInt(0))
      expect(entry.compressedSize).toBeLessThan(entry.size)
    })

    it('does not compress when compression is disabled', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME, compress: false })
      const data = new TextEncoder().encode('hello world')
      builder.addEntry('test.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.flags & PackFlags.Compressed).toBeFalsy()

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.flags & EntryFlags.Compressed).toBeFalsy()
      expect(entry.compressedSize).toBe(BigInt(data.byteLength))
    })

    it('compressionLevel 9 produces smaller output than level 0', async () => {
      const data = new TextEncoder().encode('a'.repeat(1000))

      const builder0 = new PackBuilder({ createdAt: MOCK_TIME, compress: true, compressionLevel: 0 })
      builder0.addEntry('big.txt', data, 'text/plain')
      const pack0 = await builder0.build()
      const header0 = deserializeHeader(pack0.slice(0, HEADER_SIZE))
      const indexOffset0 = Number(header0.indexOffset)
      const indexBuf0 = pack0.slice(indexOffset0, indexOffset0 + Number(header0.indexSize))
      const entry0 = deserializeIndexEntry(indexBuf0)

      const builder9 = new PackBuilder({ createdAt: MOCK_TIME, compress: true, compressionLevel: 9 })
      builder9.addEntry('big.txt', data, 'text/plain')
      const pack9 = await builder9.build()
      const header9 = deserializeHeader(pack9.slice(0, HEADER_SIZE))
      const indexOffset9 = Number(header9.indexOffset)
      const indexBuf9 = pack9.slice(indexOffset9, indexOffset9 + Number(header9.indexSize))
      const entry9 = deserializeIndexEntry(indexBuf9)

      expect(entry9.compressedSize).toBeLessThan(entry0.compressedSize)
    })

    it('compressionLevel defaults to 6 when not specified', async () => {
      const data = new TextEncoder().encode('a'.repeat(1000))

      const builderDefault = new PackBuilder({ createdAt: MOCK_TIME, compress: true })
      builderDefault.addEntry('big.txt', data, 'text/plain')
      const packDefault = await builderDefault.build()
      const headerDefault = deserializeHeader(packDefault.slice(0, HEADER_SIZE))
      const indexOffsetDefault = Number(headerDefault.indexOffset)
      const indexBufDefault = packDefault.slice(indexOffsetDefault, indexOffsetDefault + Number(headerDefault.indexSize))
      const entryDefault = deserializeIndexEntry(indexBufDefault)

      const builder6 = new PackBuilder({ createdAt: MOCK_TIME, compress: true, compressionLevel: 6 })
      builder6.addEntry('big.txt', data, 'text/plain')
      const pack6 = await builder6.build()
      const header6 = deserializeHeader(pack6.slice(0, HEADER_SIZE))
      const indexOffset6 = Number(header6.indexOffset)
      const indexBuf6 = pack6.slice(indexOffset6, indexOffset6 + Number(header6.indexSize))
      const entry6 = deserializeIndexEntry(indexBuf6)

      expect(entryDefault.compressedSize).toBe(entry6.compressedSize)
    })

    it('compressionLevel out of range is clamped', async () => {
      const data = new TextEncoder().encode('a'.repeat(1000))

      // Negative level should be clamped to 0 (no error)
      const builderNeg = new PackBuilder({ createdAt: MOCK_TIME, compress: true, compressionLevel: -1 })
      builderNeg.addEntry('big.txt', data, 'text/plain')
      const packNeg = await builderNeg.build()
      expect(packNeg.byteLength).toBeGreaterThan(0)

      // Level > 9 should be clamped to 9 (no error)
      const builderHigh = new PackBuilder({ createdAt: MOCK_TIME, compress: true, compressionLevel: 10 })
      builderHigh.addEntry('big.txt', data, 'text/plain')
      const packHigh = await builderHigh.build()
      expect(packHigh.byteLength).toBeGreaterThan(0)
    })

    it('compressionLevel is ignored when compress is false', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME, compress: false, compressionLevel: 9 })
      const data = new TextEncoder().encode('hello world')
      builder.addEntry('test.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.flags & PackFlags.Compressed).toBeFalsy()

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.compressedSize).toBe(BigInt(data.byteLength))
    })
  })

  describe('progress callbacks', () => {
    it('onProgress is called with correct phases', async () => {
      const progressEvents: Array<{
        phase: string
        current: number
        total: number
        bytesProcessed: number
        bytesTotal: number
      }> = []

      const builder = new PackBuilder({
        createdAt: MOCK_TIME,
        onProgress: (progress) => {
          progressEvents.push({ ...progress })
        },
      })

      builder.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      builder.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      builder.addEntry('c.txt', new TextEncoder().encode('test'), 'text/plain')
      await builder.build()

      const phases = progressEvents.map((e) => e.phase)
      expect(phases).toContain('scanning')
      expect(phases).toContain('packing')
      expect(phases).toContain('indexing')
      expect(phases).toContain('finalizing')
    })

    it('onProgress current increments correctly', async () => {
      const progressEvents: Array<{
        phase: string
        current: number
        total: number
      }> = []

      const builder = new PackBuilder({
        createdAt: MOCK_TIME,
        onProgress: (progress) => {
          progressEvents.push({ phase: progress.phase, current: progress.current, total: progress.total })
        },
      })

      builder.addEntry('a.txt', new TextEncoder().encode('hello'), 'text/plain')
      builder.addEntry('b.txt', new TextEncoder().encode('world'), 'text/plain')
      await builder.build()

      const packingEvents = progressEvents.filter((e) => e.phase === 'packing')
      expect(packingEvents.length).toBeGreaterThan(0)

      // Last packing event should have current === total
      const lastPacking = packingEvents[packingEvents.length - 1]
      expect(lastPacking?.current).toBe(lastPacking?.total)
    })

    it('onProgress bytesTotal equals sum of entry sizes', async () => {
      const data1 = new TextEncoder().encode('hello')
      const data2 = new TextEncoder().encode('world')

      const builder = new PackBuilder({
        createdAt: MOCK_TIME,
        onProgress: (progress) => {
          if (progress.phase === 'scanning') {
            expect(progress.bytesTotal).toBe(data1.byteLength + data2.byteLength)
          }
        },
      })

      builder.addEntry('a.txt', data1, 'text/plain')
      builder.addEntry('b.txt', data2, 'text/plain')
      await builder.build()
    })

    it('onProgress is optional', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('test.txt', new TextEncoder().encode('hello'), 'text/plain')
      const pack = await builder.build()

      expect(pack.byteLength).toBeGreaterThan(0)
    })
  })

  describe('sorted index', () => {
    it('sorts index entries by path', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('z.txt', new TextEncoder().encode('z'), 'text/plain')
      builder.addEntry('a.txt', new TextEncoder().encode('a'), 'text/plain')
      builder.addEntry('m.txt', new TextEncoder().encode('m'), 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))

      const entry1 = deserializeIndexEntry(indexBuf)
      expect(entry1.path).toBe('a.txt')

      const entry1Size = calcIndexEntrySize('a.txt', 'text/plain')
      const entry2 = deserializeIndexEntry(indexBuf.slice(entry1Size))
      expect(entry2.path).toBe('m.txt')

      const entry2Size = calcIndexEntrySize('m.txt', 'text/plain')
      const entry3 = deserializeIndexEntry(indexBuf.slice(entry1Size + entry2Size))
      expect(entry3.path).toBe('z.txt')
    })

    it('sorted index maintains correct offsets', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('z.txt', new TextEncoder().encode('z-content'), 'text/plain')
      builder.addEntry('a.txt', new TextEncoder().encode('a'), 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))

      // a.txt should be first in index (sorted)
      const entryA = deserializeIndexEntry(indexBuf)
      expect(entryA.path).toBe('a.txt')
      expect(entryA.offset).toBe(BigInt(HEADER_SIZE))

      // z.txt should be second
      const entryASize = calcIndexEntrySize('a.txt', 'text/plain')
      const entryZ = deserializeIndexEntry(indexBuf.slice(entryASize))
      expect(entryZ.path).toBe('z.txt')
      expect(entryZ.offset).toBe(BigInt(HEADER_SIZE + align8(1)))

      // Verify data integrity
      const dataA = readEntryData(pack, entryA.offset, entryA.size)
      expect(new TextDecoder().decode(dataA)).toBe('a')

      const dataZ = readEntryData(pack, entryZ.offset, entryZ.size)
      expect(new TextDecoder().decode(dataZ)).toBe('z-content')
    })
  })

  describe('identity binding', () => {
    it('encrypts entry when identityBinding is enabled', async () => {
      const builder = new PackBuilder({
        createdAt: MOCK_TIME,
        identityBinding: true,
        sub: 'user-sub-test',
        packId: 'pack-test-123',
      })
      const data = new TextEncoder().encode('secret message')
      builder.addEntry('secret.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.flags & PackFlags.Encrypted).toBeTruthy()

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.flags & EntryFlags.Encrypted).toBeTruthy()
      expect(entry.flags & EntryFlags.IdentityBound).toBeTruthy()
      expect(entry.iv).not.toEqual(new Uint8Array(12))

      const encryptedData = readEntryData(pack, entry.offset, entry.compressedSize || entry.size)
      expect(encryptedData).not.toEqual(data)
    })

    it('does not encrypt when identityBinding is disabled', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME, identityBinding: false })
      const data = new TextEncoder().encode('public message')
      builder.addEntry('public.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.flags & PackFlags.Encrypted).toBeFalsy()

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)

      expect(entry.flags & EntryFlags.Encrypted).toBeFalsy()
      expect(entry.flags & EntryFlags.IdentityBound).toBeFalsy()
    })
  })

  describe('buildToOPFS', () => {
    it('writes correct pack to OPFS file handle', async () => {
      const { fileHandle, getWrittenBuffer } = createMockFileHandle()
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const data = new TextEncoder().encode('opfs test data')
      builder.addEntry('opfs.txt', data, 'text/plain')
      await builder.buildToOPFS(fileHandle)

      const written = getWrittenBuffer()
      const header = deserializeHeader(written.slice(0, HEADER_SIZE))
      expect(header.entryCount).toBe(1)

      const indexOffset = Number(header.indexOffset)
      const indexBuf = written.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)
      expect(entry.path).toBe('opfs.txt')

      const entryData = readEntryData(written, entry.offset, entry.size)
      expect(new TextDecoder().decode(entryData)).toBe('opfs test data')
    })

    it('OPFS write includes header seek-back', async () => {
      const { fileHandle, writable } = createMockFileHandle()
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('x.txt', new TextEncoder().encode('x'), 'text/plain')
      await builder.buildToOPFS(fileHandle)

      const seekCalls = writable.seek.mock.calls
      expect(seekCalls.length).toBeGreaterThan(0)
      expect(seekCalls.some((call) => call[0] === 0)).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles empty entry data', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      builder.addEntry('empty.txt', new Uint8Array(0), 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.entryCount).toBe(1)

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)
      expect(entry.size).toBe(BigInt(0))
    })

    it('handles large entry data', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const largeData = new Uint8Array(1024 * 1024)
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256
      }
      builder.addEntry('large.bin', largeData, 'application/octet-stream')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      expect(header.entryCount).toBe(1)

      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)
      expect(entry.size).toBe(BigInt(largeData.byteLength))

      const entryData = readEntryData(pack, entry.offset, entry.size)
      expect(entryData).toEqual(largeData)
    })

    it('handles ArrayBuffer input', async () => {
      const builder = new PackBuilder({ createdAt: MOCK_TIME })
      const data = new TextEncoder().encode('from arraybuffer').buffer
      builder.addEntry('buf.txt', data, 'text/plain')
      const pack = await builder.build()

      const header = deserializeHeader(pack.slice(0, HEADER_SIZE))
      const indexOffset = Number(header.indexOffset)
      const indexBuf = pack.slice(indexOffset, indexOffset + Number(header.indexSize))
      const entry = deserializeIndexEntry(indexBuf)
      expect(entry.size).toBe(BigInt(16))
    })
  })
})
