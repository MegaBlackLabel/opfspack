import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PackWorker, ArrowIPCMetadata } from '../arrow/worker'
import { PackWorkerClient } from '../arrow/client'
import { PackBuilder } from '../builder'
async function createTestPack(): Promise<ArrayBuffer> {
  const builder = new PackBuilder()
  builder.addEntry('test.txt', new TextEncoder().encode('Hello, World!'), 'text/plain')
  builder.addEntry('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')
  return await builder.build()
}

function setCrossOriginIsolated(value: boolean | undefined): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    writable: true,
    configurable: true,
    value,
  })
}

vi.mock('comlink', () => ({
  expose: vi.fn(),
  wrap: vi.fn((worker: MockWorker) => worker.mockAPI),
}))

interface MockWorker {
  mockAPI: Record<string, unknown>
}

describe('PackWorker', () => {
  beforeEach(() => {
    setCrossOriginIsolated(true)
  })

  describe('constructor', () => {
    it('should set ipcChannel and allocate SharedArrayBuffer when crossOriginIsolated is true', () => {
      const worker = new PackWorker('test-channel', 4096)
      expect(worker.ipcChannel).toBe('test-channel')
      expect(worker.sharedBuffer).toBeInstanceOf(SharedArrayBuffer)
      expect(worker.sharedBuffer.byteLength).toBe(4096)
    })

    it('should fall back to ArrayBuffer when crossOriginIsolated is false', () => {
      setCrossOriginIsolated(false)
      const worker = new PackWorker('test-channel', 4096)
      expect(worker.ipcChannel).toBe('test-channel')
      expect(worker.sharedBuffer).toBeInstanceOf(ArrayBuffer)
      expect(worker.sharedBuffer.byteLength).toBe(4096)
    })

    it('should fall back to ArrayBuffer when crossOriginIsolated is undefined', () => {
      setCrossOriginIsolated(undefined)
      const worker = new PackWorker('test-channel', 4096)
      expect(worker.sharedBuffer).toBeInstanceOf(ArrayBuffer)
    })
  })

  describe('isSharedArrayBufferSupported', () => {
    it('should return true when crossOriginIsolated is true', () => {
      setCrossOriginIsolated(true)
      const worker = new PackWorker('test-channel', 1024)
      expect(worker.isSharedArrayBufferSupported()).toBe(true)
    })

    it('should return false when crossOriginIsolated is false', () => {
      setCrossOriginIsolated(false)
      const worker = new PackWorker('test-channel', 1024)
      expect(worker.isSharedArrayBufferSupported()).toBe(false)
    })

    it('should return false when crossOriginIsolated is undefined', () => {
      setCrossOriginIsolated(undefined)
      const worker = new PackWorker('test-channel', 1024)
      expect(worker.isSharedArrayBufferSupported()).toBe(false)
    })
  })

  describe('readEntry', () => {
    it('should return PackEntryProxy with entry data', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntry('test-pack', 'test.txt')

      expect(proxy.path).toBe('test.txt')
      expect(proxy.mimeType).toBe('text/plain')
      expect(proxy.data).toBeInstanceOf(Uint8Array)
      const text = new TextDecoder().decode(proxy.data)
      expect(text).toBe('Hello, World!')
      expect(proxy.transfer).toBeInstanceOf(Array)
    })

    it('should copy data into shared buffer for zero-copy access', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntry('test-pack', 'test.txt')

      if (worker.isSharedArrayBufferSupported()) {
        expect(proxy.data.buffer).toBe(worker.sharedBuffer)
      }
    })

    it('should throw when pack is not found', async () => {
      const worker = new PackWorker('test-channel', 1024)
      await expect(worker.readEntry('missing-pack', 'test.txt')).rejects.toThrow('Pack not found')
    })

    it('should throw when entry is not found', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 1024)
      worker.loadPack('test-pack', packBuffer)

      await expect(worker.readEntry('test-pack', 'missing.txt')).rejects.toThrow('Entry not found')
    })
  })

  describe('readEntryRange', () => {
    it('should return byte range of entry data', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntryRange('test-pack', 'test.txt', 0, 5)

      expect(proxy.path).toBe('test.txt')
      expect(proxy.mimeType).toBe('text/plain')
      const text = new TextDecoder().decode(proxy.data)
      expect(text).toBe('Hello')
    })

    it('should return correct mid-range bytes', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntryRange('test-pack', 'test.txt', 7, 12)

      const text = new TextDecoder().decode(proxy.data)
      expect(text).toBe('World')
    })

    it('should throw for invalid range', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 1024)
      worker.loadPack('test-pack', packBuffer)

      await expect(worker.readEntryRange('test-pack', 'test.txt', 5, 5)).rejects.toThrow('Invalid range')
      await expect(worker.readEntryRange('test-pack', 'test.txt', 100, 200)).rejects.toThrow('Invalid range')
    })

    it('should throw when pack is not found', async () => {
      const worker = new PackWorker('test-channel', 1024)
      await expect(worker.readEntryRange('missing-pack', 'test.txt', 0, 5)).rejects.toThrow('Pack not found')
    })
  })

  describe('listEntries', () => {
    it('should return Arrow IPC metadata with entry list', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 1024)
      worker.loadPack('test-pack', packBuffer)

      const metadata = await worker.listEntries('test-pack')

      expect(metadata.schema).toBeDefined()
      expect(metadata.schema.fields).toBeInstanceOf(Array)
      expect(metadata.recordCount).toBe(2)
      expect(metadata.records).toHaveLength(2)
    })

    it('should include correct field schema', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 1024)
      worker.loadPack('test-pack', packBuffer)

      const metadata = await worker.listEntries('test-pack')

      const fieldNames = metadata.schema.fields.map((f) => f.name)
      expect(fieldNames).toContain('path')
      expect(fieldNames).toContain('mimeType')
      expect(fieldNames).toContain('size')
    })

    it('should include entry data in records', async () => {
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 1024)
      worker.loadPack('test-pack', packBuffer)

      const metadata = await worker.listEntries('test-pack')

      const paths = metadata.records.map((r) => r.path)
      expect(paths).toContain('test.txt')
      expect(paths).toContain('image.png')

      const txtRecord = metadata.records.find((r) => r.path === 'test.txt')
      expect(txtRecord).toBeDefined()
      expect(txtRecord!.mimeType).toBe('text/plain')
      expect(txtRecord!.size).toBe(13)
    })

    it('should throw when pack is not found', async () => {
      const worker = new PackWorker('test-channel', 1024)
      await expect(worker.listEntries('missing-pack')).rejects.toThrow('Pack not found')
    })
  })

  describe('SAB data transfer', () => {
    it('should use SharedArrayBuffer data view when SAB is supported', async () => {
      setCrossOriginIsolated(true)
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntry('test-pack', 'test.txt')

      expect(worker.sharedBuffer).toBeInstanceOf(SharedArrayBuffer)
      expect(proxy.data.buffer).toBe(worker.sharedBuffer)
    })

    it('should use regular ArrayBuffer when SAB is not supported', async () => {
      setCrossOriginIsolated(false)
      const packBuffer = await createTestPack()
      const worker = new PackWorker('test-channel', 65536)
      worker.loadPack('test-pack', packBuffer)

      const proxy = await worker.readEntry('test-pack', 'test.txt')

      expect(worker.sharedBuffer).toBeInstanceOf(ArrayBuffer)
      expect(proxy.data.buffer).toBe(worker.sharedBuffer)
      expect(proxy.transfer).toContain(worker.sharedBuffer)
    })
  })
})

describe('PackWorkerClient', () => {
  it('should wrap a Worker with Comlink', () => {
    const mockWorker = {
      mockAPI: {
        readEntry: vi.fn().mockResolvedValue({
          path: 'test.txt',
          mimeType: 'text/plain',
          data: new Uint8Array([1, 2, 3]),
          transfer: [],
        }),
      },
    } as unknown as MockWorker & Worker

    const client = new PackWorkerClient(mockWorker)
    expect(client).toBeDefined()
  })

  it('should call readEntry via Comlink proxy', async () => {
    const mockProxy = {
      readEntry: vi.fn().mockResolvedValue({
        path: 'test.txt',
        mimeType: 'text/plain',
        data: new Uint8Array([1, 2, 3]),
        transfer: [],
      }),
    }

    const mockWorker = {
      mockAPI: mockProxy,
    } as unknown as MockWorker & Worker

    const client = new PackWorkerClient(mockWorker)
    const result = await client.readEntryAsProxy('test-pack', 'test.txt')

    expect(mockProxy.readEntry).toHaveBeenCalledWith('test-pack', 'test.txt')
    expect(result.path).toBe('test.txt')
    expect(result.mimeType).toBe('text/plain')
  })

  it('should expose ipcChannel from wrapped worker', async () => {
    const mockProxy = {
      ipcChannel: 'arrow-channel',
      readEntry: vi.fn(),
    }

    const mockWorker = {
      mockAPI: mockProxy,
    } as unknown as MockWorker & Worker

    const client = new PackWorkerClient(mockWorker)
    expect(client.ipcChannel).toBe('arrow-channel')
  })
})

describe('ArrowIPCMetadata structure', () => {
  it('should be a valid Arrow IPC-like metadata object', () => {
    const metadata: ArrowIPCMetadata = {
      schema: {
        fields: [
          { name: 'path', type: 'string' },
          { name: 'size', type: 'int64' },
        ],
      },
      recordCount: 1,
      records: [{ path: 'test.txt', size: 42 }],
    }

    expect(metadata.schema.fields).toHaveLength(2)
    expect(metadata.schema.fields[0]!.name).toBe('path')
    expect(metadata.schema.fields[0]!.type).toBe('string')
    expect(metadata.recordCount).toBe(1)
    expect(metadata.records[0]!.path).toBe('test.txt')
  })
})
