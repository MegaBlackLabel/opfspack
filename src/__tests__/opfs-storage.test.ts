import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OPFSPackStorage } from '../storage/opfs'
import { PackNotFoundError } from '../errors'

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

  return {
    createWritable: vi.fn(async () => {
      const mockWritable = createMockWritable()
      return {
        write: async (chunk: ArrayBuffer) => {
          await mockWritable.write(chunk)
        },
        close: async () => {
          await mockWritable.close()
          fileData = mockWritable._getData()
        },
      }
    }),
    getFile: vi.fn(async () => {
      if (!fileData) {
        const err = new DOMException('File not found', 'NotFoundError')
        throw err
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
      throw new DOMException('File not found', 'NotFoundError')
    }),
    removeEntry: vi.fn(async (name: string) => {
      if (!files.has(name)) {
        throw new DOMException('File not found', 'NotFoundError')
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

describe('OPFSPackStorage', () => {
  let mockDir: ReturnType<typeof createMockDirectoryHandle>
  let storage: OPFSPackStorage

  beforeEach(() => {
    mockDir = createMockDirectoryHandle()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => mockDir),
      },
    })
    storage = new OPFSPackStorage()
  })

  describe('write', () => {
    it('writes pack data to OPFS', async () => {
      const data = new TextEncoder().encode('test pack data').buffer
      await storage.write('pack-1', data)

      expect(mockDir.getFileHandle).toHaveBeenCalledWith('pack-1', { create: true })
      expect(mockDir._files.has('pack-1')).toBe(true)
    })

    it('overwrites existing pack', async () => {
      const data1 = new TextEncoder().encode('first').buffer
      const data2 = new TextEncoder().encode('second').buffer

      await storage.write('pack-1', data1)
      await storage.write('pack-1', data2)

      const handle = mockDir._files.get('pack-1')
      expect(handle).toBeDefined()
      const file = await handle!.getFile()
      const result = await file.arrayBuffer()
      expect(new TextDecoder().decode(result)).toBe('second')
    })
  })

  describe('read', () => {
    it('reads pack data from OPFS', async () => {
      const data = new TextEncoder().encode('test pack data').buffer
      await storage.write('pack-1', data)

      const result = await storage.read('pack-1')
      expect(new TextDecoder().decode(result)).toBe('test pack data')
    })

    it('throws PackNotFoundError for missing pack', async () => {
      await expect(storage.read('non-existent')).rejects.toThrow(PackNotFoundError)
    })
  })

  describe('delete', () => {
    it('deletes pack from OPFS', async () => {
      const data = new TextEncoder().encode('test').buffer
      await storage.write('pack-1', data)
      expect(await storage.exists('pack-1')).toBe(true)

      await storage.delete('pack-1')

      expect(await storage.exists('pack-1')).toBe(false)
    })

    it('throws PackNotFoundError when deleting non-existent pack', async () => {
      await expect(storage.delete('non-existent')).rejects.toThrow(PackNotFoundError)
    })
  })

  describe('list', () => {
    it('lists all packs in OPFS', async () => {
      await storage.write('pack-a', new ArrayBuffer(1))
      await storage.write('pack-b', new ArrayBuffer(2))

      const list = await storage.list()
      expect(list.sort()).toEqual(['pack-a', 'pack-b'])
    })

    it('returns empty array when no packs exist', async () => {
      const list = await storage.list()
      expect(list).toEqual([])
    })
  })

  describe('exists', () => {
    it('returns true for existing pack', async () => {
      await storage.write('existing-pack', new ArrayBuffer(1))
      expect(await storage.exists('existing-pack')).toBe(true)
    })

    it('returns false for missing pack', async () => {
      expect(await storage.exists('missing-pack')).toBe(false)
    })
  })

  describe('error handling', () => {
    it('handles OPFS errors gracefully on write', async () => {
      mockDir.getFileHandle = vi.fn(async () => {
        throw new Error('OPFS write error')
      })

      await expect(storage.write('pack-1', new ArrayBuffer(1))).rejects.toThrow('OPFS write error')
    })

    it('handles OPFS errors gracefully on read', async () => {
      const handle = createMockFileHandle(new ArrayBuffer(1))
      handle.getFile = vi.fn(async () => {
        throw new Error('OPFS read error')
      })
      mockDir.getFileHandle = vi.fn(async () => handle)

      await expect(storage.read('pack-1')).rejects.toThrow('OPFS read error')
    })
  })
})
