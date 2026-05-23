import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PackBuilder } from '../builder'
import { PackReader } from '../reader'
import { PackManager, MemoryPackStorage, type PackFile } from '../manager'
import { OPFSPackStorage } from '../storage/opfs'
import { PackWorker } from '../arrow/worker'
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

function createMockWritable() {
  const chunks: ArrayBuffer[] = []
  return {
    write: vi.fn(async (chunk: ArrayBuffer) => {
      chunks.push(chunk)
    }),
    close: vi.fn(async () => {}),
    _getData: () => {
      if (chunks.length === 0) return new ArrayBuffer(0)
      const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(new Uint8Array(chunk), offset)
        offset += chunk.byteLength
      }
      return result.buffer
    },
  }
}

function createMockFile(data: ArrayBuffer) {
  return {
    arrayBuffer: vi.fn(async () => data),
    size: data.byteLength,
    name: 'mock-file',
    type: 'application/octet-stream',
  } as unknown as File
}

function createMockFileHandle(initialData?: ArrayBuffer) {
  let fileData = initialData
  const mockWritable = createMockWritable()

  return {
    createWritable: vi.fn(async () => ({
      write: async (chunk: ArrayBuffer) => {
        await mockWritable.write(chunk)
      },
      seek: vi.fn(async () => {}),
      close: async () => {
        await mockWritable.close()
        fileData = mockWritable._getData()
      },
    })),
    getFile: vi.fn(async () => {
      if (!fileData) {
        throw new Error('File not found')
      }
      return createMockFile(fileData)
    }),
    _setData: (data: ArrayBuffer) => {
      fileData = data
    },
  }
}

function createMockDirectoryHandle() {
  const files = new Map<string, ReturnType<typeof createMockFileHandle>>()

  return {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (files.has(name)) {
        return files.get(name)!
      }
      if (options?.create) {
        const handle = createMockFileHandle()
        files.set(name, handle)
        return handle
      }
      throw new Error('File not found')
    }),
    removeEntry: vi.fn(async (name: string) => {
      if (!files.has(name)) {
        throw new Error('File not found')
      }
      files.delete(name)
    }),
    keys: async function* () {
      for (const name of files.keys()) {
        yield name
      }
    },
    _files: files,
  }
}

function setCrossOriginIsolated(value: boolean | undefined): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    writable: true,
    configurable: true,
    value,
  })
}

describe('Integration: End-to-End Roundtrip', () => {
  it('builds pack, stores in memory, reads back all entries', async () => {
    const builder = new PackBuilder()
    const entries: PackFile[] = [
      { path: 'hello.txt', data: new TextEncoder().encode('hello world'), mimeType: 'text/plain' },
      { path: 'image.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
      { path: 'data.json', data: new TextEncoder().encode('{"key":"value"}'), mimeType: 'application/json' },
    ]

    for (const entry of entries) {
      builder.addEntry(entry.path, entry.data, entry.mimeType)
    }

    const pack = await builder.build()
    const storage = new MemoryPackStorage()
    await storage.write('test-pack', pack)

    const readData = await storage.read('test-pack')
    const reader = PackReader.fromBuffer(readData)

    expect(reader.metadata.entryCount).toBe(entries.length)
    expect(reader.listEntries()).toHaveLength(entries.length)

    for (const entry of entries) {
      expect(reader.hasEntry(entry.path)).toBe(true)
      const info = reader.getEntryInfo(entry.path)
      expect(info).toBeDefined()
      expect(info!.mimeType).toBe(entry.mimeType)

      const data = await reader.readEntry(entry.path)
      const expected = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data)
      expect(new Uint8Array(data)).toEqual(expected)
    }

    reader.close()
  })

  it('roundtrips multiple create/read cycles with various data sizes', async () => {
    const storage = new MemoryPackStorage()
    const manager = new PackManager(storage)
    const sizes = [0, 1, 100, 4096, 1024 * 1024]

    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i]!
      const packId = `roundtrip-${i}`
      const data = createRandomData(size)
      const files: PackFile[] = [{ path: 'data.bin', data, mimeType: 'application/octet-stream' }]

      await manager.createPack(packId, files)
      const readData = await manager.readFile(packId, 'data.bin')
      expect(new Uint8Array(readData)).toEqual(data)
    }
  })

  it('roundtrips with compression enabled', async () => {
    const storage = new MemoryPackStorage()
    const manager = new PackManager(storage)
    const data = new TextEncoder().encode('a'.repeat(10000))
    const files: PackFile[] = [{ path: 'compressed.txt', data, mimeType: 'text/plain' }]

    await manager.createPack('compressed-pack', files, { compression: 'deflate' })

    const reader = await manager.openPack('compressed-pack')
    expect(reader.metadata.entryCount).toBe(1)

    const readData = await reader.readEntry('compressed.txt')
    expect(new TextDecoder().decode(readData)).toBe('a'.repeat(10000))
    reader.close()
  })

  it('roundtrips with identity binding enabled', async () => {
    const storage = new MemoryPackStorage()
    const manager = new PackManager(storage)
    const data = new TextEncoder().encode('secret identity data')
    const files: PackFile[] = [{ path: 'secret.txt', data, mimeType: 'text/plain' }]

    await manager.createPack('identity-pack', files, {
      identityBinding: true,
    })

    const readData = await manager.readFile('identity-pack', 'secret.txt', {
      identitySub: 'user-sub-test',
      packId: 'identity-pack',
    })
    expect(new TextDecoder().decode(readData)).toBe('secret identity data')
  })

  it('roundtrips with compression + identity binding combined', async () => {
    const storage = new MemoryPackStorage()
    const manager = new PackManager(storage)
    const data = new TextEncoder().encode('x'.repeat(5000))
    const files: PackFile[] = [{ path: 'combo.txt', data, mimeType: 'text/plain' }]

    await manager.createPack('combo-pack', files, {
      compression: 'deflate',
      identityBinding: true,
    })

    const readData = await manager.readFile('combo-pack', 'combo.txt', {
      identitySub: 'user-sub-test',
      packId: 'combo-pack',
    })
    expect(new TextDecoder().decode(readData)).toBe('x'.repeat(5000))
  })
})

describe('Integration: PackManager + OPFSPackStorage', () => {
  let mockDir: ReturnType<typeof createMockDirectoryHandle>

  beforeEach(() => {
    mockDir = createMockDirectoryHandle()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => mockDir),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('performs full CRUD with OPFSPackStorage', async () => {
    const storage = new OPFSPackStorage()
    const manager = new PackManager(storage)

    const files: PackFile[] = [
      { path: 'a.txt', data: new TextEncoder().encode('alpha'), mimeType: 'text/plain' },
      { path: 'b.txt', data: new TextEncoder().encode('beta'), mimeType: 'text/plain' },
    ]

    await manager.createPack('opfs-pack', files)
    expect(await manager.hasPack('opfs-pack')).toBe(true)

    const reader = await manager.openPack('opfs-pack')
    expect(reader.metadata.entryCount).toBe(2)
    expect(reader.hasEntry('a.txt')).toBe(true)
    expect(reader.hasEntry('b.txt')).toBe(true)
    reader.close()

    const data = await manager.readFile('opfs-pack', 'a.txt')
    expect(new TextDecoder().decode(data)).toBe('alpha')

    const packs = await manager.listPacks()
    expect(packs).toHaveLength(1)
    expect(packs[0]!.packId).toBe('opfs-pack')
    expect(packs[0]!.entryCount).toBe(2)

    await manager.deletePack('opfs-pack')
    expect(await manager.hasPack('opfs-pack')).toBe(false)
  })

  it('reads from OPFS via PackReader.fromOPFS', async () => {
    const builder = new PackBuilder()
    builder.addEntry('test.txt', new TextEncoder().encode('opfs content'), 'text/plain')
    const pack = await builder.build()

    const storage = new OPFSPackStorage()
    await storage.write('direct-pack', pack)

    const handle = mockDir._files.get('direct-pack')
    expect(handle).toBeDefined()

    const reader = await PackReader.fromOPFS(handle! as unknown as FileSystemFileHandle)
    expect(reader.metadata.entryCount).toBe(1)
    const data = await reader.readEntry('test.txt')
    expect(new TextDecoder().decode(data)).toBe('opfs content')
    reader.close()
  })
})

describe('Integration: Arrow IPC + SAB Zero-Copy Transfer', () => {
  beforeEach(() => {
    setCrossOriginIsolated(true)
  })

  it('loads pack into worker and reads entries with zero-copy', async () => {
    const builder = new PackBuilder()
    builder.addEntry('doc.txt', new TextEncoder().encode('document content'), 'text/plain')
    builder.addEntry('sheet.csv', new TextEncoder().encode('a,b,c\n1,2,3\n'), 'text/csv')
    const pack = await builder.build()

    const worker = new PackWorker('integration-channel', 65536)
    worker.loadPack('docs', pack)

    const proxy1 = await worker.readEntry('docs', 'doc.txt')
    expect(proxy1.path).toBe('doc.txt')
    expect(proxy1.mimeType).toBe('text/plain')
    expect(new TextDecoder().decode(proxy1.data)).toBe('document content')

    if (worker.isSharedArrayBufferSupported()) {
      expect(proxy1.data.buffer).toBe(worker.sharedBuffer)
    }

    const proxy2 = await worker.readEntry('docs', 'sheet.csv')
    expect(proxy2.path).toBe('sheet.csv')
    expect(new TextDecoder().decode(proxy2.data)).toBe('a,b,c\n1,2,3\n')

    const metadata = await worker.listEntries('docs')
    expect(metadata.recordCount).toBe(2)
    expect(metadata.records.map((r) => r.path)).toContain('doc.txt')
    expect(metadata.records.map((r) => r.path)).toContain('sheet.csv')
  })

  it('reads entry range via worker with zero-copy', async () => {
    const builder = new PackBuilder()
    builder.addEntry('large.txt', new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'text/plain')
    const pack = await builder.build()

    const worker = new PackWorker('range-channel', 65536)
    worker.loadPack('alpha', pack)

    const proxy = await worker.readEntryRange('alpha', 'large.txt', 5, 15)
    expect(new TextDecoder().decode(proxy.data)).toBe('FGHIJKLMNO')

    if (worker.isSharedArrayBufferSupported()) {
      expect(proxy.data.buffer).toBe(worker.sharedBuffer)
    }
  })

  it('falls back to ArrayBuffer transfer when SAB is unavailable', async () => {
    setCrossOriginIsolated(false)

    const builder = new PackBuilder()
    builder.addEntry('fallback.txt', new TextEncoder().encode('fallback data'), 'text/plain')
    const pack = await builder.build()

    const worker = new PackWorker('fallback-channel', 65536)
    worker.loadPack('fb', pack)

    expect(worker.isSharedArrayBufferSupported()).toBe(false)
    expect(worker.sharedBuffer).toBeInstanceOf(ArrayBuffer)

    const proxy = await worker.readEntry('fb', 'fallback.txt')
    expect(new TextDecoder().decode(proxy.data)).toBe('fallback data')
    expect(proxy.transfer).toContain(worker.sharedBuffer)
  })
})

describe('Integration: Migration + Validation', () => {
  it('migrates files and validates resulting packs', async () => {
    const storage = new MemoryPackStorage()

    const files = [
      { path: 'book1/page1.png', data: new TextEncoder().encode('png1') },
      { path: 'book1/page2.png', data: new TextEncoder().encode('png2') },
      { path: 'book2/cover.jpg', data: new TextEncoder().encode('cover') },
      { path: 'book2/chapter1.txt', data: new TextEncoder().encode('chapter one') },
    ]

    const fs = {
      listFiles: async () => files,
    }

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(2)
    expect(result.packs.sort()).toEqual(['book1', 'book2'])
    expect(result.errors).toHaveLength(0)

    for (const packId of result.packs) {
      const packData = await storage.read(packId)
      const isValid = await validatePack(packData)
      expect(isValid).toBe(true)

      const reader = PackReader.fromBuffer(packData)
      expect(reader.metadata.entryCount).toBeGreaterThan(0)
      reader.close()
    }
  })

  it('reports progress during migration', async () => {
    const storage = new MemoryPackStorage()
    const progressEvents: Array<{ currentBook: string; totalBooks: number; currentFile: number; totalFiles: number }> = []

    const files = [
      { path: 'alpha/file1.txt', data: new TextEncoder().encode('a1') },
      { path: 'alpha/file2.txt', data: new TextEncoder().encode('a2') },
      { path: 'beta/file1.txt', data: new TextEncoder().encode('b1') },
    ]

    const fs = { listFiles: async () => files }

    await migrateToPacks(fs, storage, {
      onProgress: (p) => progressEvents.push(p),
    })

    expect(progressEvents.length).toBe(3)
    expect(progressEvents[0]!.currentBook).toBe('alpha')
    expect(progressEvents[0]!.totalBooks).toBe(2)
    expect(progressEvents[0]!.currentFile).toBe(1)
    expect(progressEvents[progressEvents.length - 1]!.currentFile).toBe(1)
  })

  it('validates corrupted pack returns false', async () => {
    const corrupted = new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer
    const isValid = await validatePack(corrupted)
    expect(isValid).toBe(false)
  })

  it('validates empty pack data returns false', async () => {
    const isValid = await validatePack(new ArrayBuffer(0))
    expect(isValid).toBe(false)
  })
})

describe('Integration: PackManager with corrupted packs in listPacks', () => {
  it('skips corrupted packs when listing', async () => {
    const storage = new MemoryPackStorage()
    const manager = new PackManager(storage)

    const validFiles: PackFile[] = [
      { path: 'valid.txt', data: new TextEncoder().encode('valid'), mimeType: 'text/plain' },
    ]
    await manager.createPack('valid-pack', validFiles)

    const corrupted = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer
    await storage.write('corrupted-pack', corrupted)

    const packs = await manager.listPacks()
    expect(packs).toHaveLength(1)
    expect(packs[0]!.packId).toBe('valid-pack')
  })
})

describe('Integration: Multiple entries stress test', () => {
  it('handles 100+ entries in a single pack', async () => {
    const builder = new PackBuilder()
    const expectedData = new Map<string, Uint8Array>()

    for (let i = 0; i < 100; i++) {
      const path = `entry-${i.toString().padStart(3, '0')}.txt`
      const data = createRandomData(100 + (i % 900))
      expectedData.set(path, data)
      builder.addEntry(path, data, 'text/plain')
    }

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    expect(reader.metadata.entryCount).toBe(100)
    const entries = reader.listEntries()
    expect(entries).toHaveLength(100)

    for (const [path, expected] of expectedData) {
      const actual = await reader.readEntry(path)
      expect(new Uint8Array(actual)).toEqual(expected)
    }

    reader.close()
  })

  it('handles 1MB+ entry', async () => {
    const builder = new PackBuilder()
    const data = createRandomData(1024 * 1024 + 1)
    builder.addEntry('large.bin', data, 'application/octet-stream')

    const pack = await builder.build()
    const reader = PackReader.fromBuffer(pack)

    const actual = await reader.readEntry('large.bin')
    expect(new Uint8Array(actual)).toEqual(data)
    reader.close()
  })
})
