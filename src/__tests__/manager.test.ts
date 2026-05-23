import { describe, it, expect, beforeEach } from 'vitest'
import { PackManager, PackStorage } from '../manager'
import { PackNotFoundError } from '../errors'
import { PackOptions } from '../types'

class MemoryPackStorage implements PackStorage {
  private store = new Map<string, ArrayBuffer>()

  async write(packId: string, data: ArrayBuffer): Promise<void> {
    this.store.set(packId, data)
  }

  async read(packId: string): Promise<ArrayBuffer> {
    const data = this.store.get(packId)
    if (!data) {
      throw new PackNotFoundError(`Pack not found: ${packId}`)
    }
    return data
  }

  async delete(packId: string): Promise<void> {
    this.store.delete(packId)
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys())
  }

  async exists(packId: string): Promise<boolean> {
    return this.store.has(packId)
  }
}

interface TestFile {
  path: string
  data: Uint8Array
  mimeType: string
}

function createTestFiles(): TestFile[] {
  return [
    {
      path: 'hello.txt',
      data: new TextEncoder().encode('hello world'),
      mimeType: 'text/plain',
    },
    {
      path: 'data.json',
      data: new TextEncoder().encode('{"key": "value"}'),
      mimeType: 'application/json',
    },
  ]
}

describe('PackManager', () => {
  let storage: MemoryPackStorage
  let manager: PackManager

  beforeEach(() => {
    storage = new MemoryPackStorage()
    manager = new PackManager(storage)
  })

  describe('createPack', () => {
    it('creates a pack from file list', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-1'

      await manager.createPack(packId, files)

      const exists = await manager.hasPack(packId)
      expect(exists).toBe(true)
    })

    it('creates a pack with options', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-2'
      const options: PackOptions = { compression: 'deflate' }

      await manager.createPack(packId, files, options)

      const exists = await manager.hasPack(packId)
      expect(exists).toBe(true)
    })
  })

  describe('openPack', () => {
    it('opens existing pack for reading', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-open'
      await manager.createPack(packId, files)

      const reader = await manager.openPack(packId)

      expect(reader).toBeDefined()
      expect(reader.metadata.entryCount).toBe(2)
      expect(reader.hasEntry('hello.txt')).toBe(true)
      expect(reader.hasEntry('data.json')).toBe(true)
      reader.close()
    })

    it('throws PackNotFoundError for missing pack', async () => {
      await expect(manager.openPack('non-existent')).rejects.toThrow(PackNotFoundError)
    })
  })

  describe('deletePack', () => {
    it('deletes pack and cleans up', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-delete'
      await manager.createPack(packId, files)

      await manager.deletePack(packId)

      const exists = await manager.hasPack(packId)
      expect(exists).toBe(false)
    })

    it('throws PackNotFoundError when deleting non-existent pack', async () => {
      await expect(manager.deletePack('non-existent')).rejects.toThrow(PackNotFoundError)
    })
  })

  describe('listPacks', () => {
    it('lists all packs with correct metadata', async () => {
      const files1 = [{ path: 'a.txt', data: new TextEncoder().encode('a'), mimeType: 'text/plain' }]
      const files2 = [{ path: 'b.txt', data: new TextEncoder().encode('b'), mimeType: 'text/plain' }]

      await manager.createPack('pack-1', files1)
      await manager.createPack('pack-2', files2)

      const packs = await manager.listPacks()

      expect(packs).toHaveLength(2)
      expect(packs.map((p) => p.packId).sort()).toEqual(['pack-1', 'pack-2'])
      expect(packs[0]?.entryCount).toBe(1)
      expect(packs[1]?.entryCount).toBe(1)
    })

    it('returns empty array when no packs exist', async () => {
      const packs = await manager.listPacks()
      expect(packs).toEqual([])
    })
  })

  describe('readFile', () => {
    it('reads file from pack', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-read'
      await manager.createPack(packId, files)

      const data = await manager.readFile(packId, 'hello.txt')
      const text = new TextDecoder().decode(data)

      expect(text).toBe('hello world')
    })

    it('reads multiple files from pack', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-read-multi'
      await manager.createPack(packId, files)

      const data1 = await manager.readFile(packId, 'hello.txt')
      const data2 = await manager.readFile(packId, 'data.json')

      expect(new TextDecoder().decode(data1)).toBe('hello world')
      expect(new TextDecoder().decode(data2)).toBe('{"key": "value"}')
    })

    it('throws PackNotFoundError when pack does not exist', async () => {
      await expect(manager.readFile('non-existent', 'file.txt')).rejects.toThrow(PackNotFoundError)
    })

    it('throws error when file does not exist in pack', async () => {
      const files = createTestFiles()
      const packId = 'test-pack-read-missing'
      await manager.createPack(packId, files)

      await expect(manager.readFile(packId, 'missing.txt')).rejects.toThrow('Entry not found')
    })
  })

  describe('hasPack', () => {
    it('returns true for existing pack', async () => {
      const files = createTestFiles()
      await manager.createPack('existing-pack', files)

      expect(await manager.hasPack('existing-pack')).toBe(true)
    })

    it('returns false for missing pack', async () => {
      expect(await manager.hasPack('missing-pack')).toBe(false)
    })
  })

  describe('MemoryPackStorage', () => {
    it('stores and retrieves pack data', async () => {
      const data = new TextEncoder().encode('test data').buffer
      await storage.write('pack-1', data)

      const retrieved = await storage.read('pack-1')
      expect(new Uint8Array(retrieved)).toEqual(new Uint8Array(data))
    })

    it('deletes pack data', async () => {
      const data = new TextEncoder().encode('test data').buffer
      await storage.write('pack-1', data)
      await storage.delete('pack-1')

      expect(await storage.exists('pack-1')).toBe(false)
    })

    it('lists all stored packs', async () => {
      await storage.write('pack-a', new ArrayBuffer(1))
      await storage.write('pack-b', new ArrayBuffer(2))

      const list = await storage.list()
      expect(list.sort()).toEqual(['pack-a', 'pack-b'])
    })
  })
})
