import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLitePackStorage } from '../db/storage'
import type { PackMetadata } from '../types'

describe('SQLitePackStorage', () => {
  let storage: SQLitePackStorage

  beforeEach(async () => {
    storage = new SQLitePackStorage()
    await storage.init()
  })

  afterEach(async () => {
    await storage.close()
  })

  it('should insert and retrieve pack metadata', async () => {
    const metadata: PackMetadata = {
      version: 2,
      flags: 0,
      entryCount: 5,
      createdAt: new Date('2024-01-01'),
    }

    await storage.insertPack('book-123', metadata, 1024, 'packs/book-123.opfspack', false)

    const retrieved = await storage.getPackMetadata('book-123')
    expect(retrieved).toBeDefined()
      expect(retrieved!.version).toBe(2)
    expect(retrieved!.entryCount).toBe(5)
  })

  it('should insert and retrieve pack entries', async () => {
    const metadata: PackMetadata = {
      version: 2,
      flags: 0,
      entryCount: 2,
      createdAt: new Date(),
    }

    await storage.insertPack('book-456', metadata, 2048, 'packs/book-456.opfspack', true)
    
    const entries = [
      {
        path: 'pages/page_001.webp',
        mimeType: 'image/webp',
        size: 100,
        compressedSize: 100,
        flags: 0,
        offset: 0n,
      },
      {
        path: 'book.pdf',
        mimeType: 'application/pdf',
        size: 500,
        compressedSize: 500,
        flags: 0,
        offset: 128n,
      },
    ]

    await storage.insertEntries('book-456', entries)

    const retrieved = await storage.getPackEntries('book-456')
    expect(retrieved).toHaveLength(2)
    const paths = retrieved.map((e) => e.path).sort()
    expect(paths).toEqual(['book.pdf', 'pages/page_001.webp'])
  })

  it('should find specific entry by path', async () => {
    const metadata: PackMetadata = {
      version: 2,
      flags: 0,
      entryCount: 1,
      createdAt: new Date(),
    }

    await storage.insertPack('book-789', metadata, 512, 'packs/book-789.opfspack', false)
    
    await storage.insertEntries('book-789', [
      {
        path: 'cover.webp',
        mimeType: 'image/webp',
        size: 200,
        compressedSize: 200,
        flags: 0,
        offset: 0n,
      },
    ])

    const entry = await storage.findEntry('book-789', 'cover.webp')
    expect(entry).toBeDefined()
    expect(entry!.mimeType).toBe('image/webp')
    expect(entry!.size).toBe(200)
  })

  it('should list all packs', async () => {
    const metadata: PackMetadata = {
      version: 2,
      flags: 0,
      entryCount: 0,
      createdAt: new Date(),
    }

    await storage.insertPack('pack-a', metadata, 100, 'packs/pack-a.opfspack', false)
    await storage.insertPack('pack-b', metadata, 200, 'packs/pack-b.opfspack', false)

    const packs = await storage.list()
    expect(packs).toHaveLength(2)
    expect(packs).toContain('pack-a')
    expect(packs).toContain('pack-b')
  })

  it('should delete pack and cascade entries', async () => {
    const metadata: PackMetadata = {
      version: 2,
      flags: 0,
      entryCount: 1,
      createdAt: new Date(),
    }

    await storage.insertPack('pack-to-delete', metadata, 100, 'packs/pack-to-delete.opfspack', false)
    await storage.insertEntries('pack-to-delete', [
      {
        path: 'test.txt',
        mimeType: 'text/plain',
        size: 10,
        compressedSize: 10,
        flags: 0,
        offset: 0n,
      },
    ])

    await storage.delete('pack-to-delete')

    const exists = await storage.exists('pack-to-delete')
    expect(exists).toBe(false)

    const entries = await storage.getPackEntries('pack-to-delete')
    expect(entries).toHaveLength(0)
  })
})
