import { describe, it, expect, beforeEach } from 'vitest'
import { migrateToPacks, validatePack, type MigrationOptions, type FileSystem } from '../migration'
import { MemoryPackStorage, type PackStorage } from '../manager'

class TestFileSystem implements FileSystem {
  private files: Array<{ path: string; data: Uint8Array }> = []

  constructor(files: Array<{ path: string; data: Uint8Array }> = []) {
    this.files = files
  }

  async listFiles(): Promise<Array<{ path: string; data: Uint8Array }>> {
    return this.files
  }
}

describe('migrateToPacks', () => {
  let storage: PackStorage

  beforeEach(() => {
    storage = new MemoryPackStorage()
  })

  it('migrates single book files to pack', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/page1.png', data: new TextEncoder().encode('page1') },
      { path: 'book1/page2.png', data: new TextEncoder().encode('page2') },
    ])

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(1)
    expect(result.packs[0]).toBe('book1')
    expect(result.errors).toHaveLength(0)

    const packData = await storage.read('book1')
    expect(packData.byteLength).toBeGreaterThan(0)
  })

  it('migrates multiple books to separate packs', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/page1.png', data: new TextEncoder().encode('b1p1') },
      { path: 'book1/page2.png', data: new TextEncoder().encode('b1p2') },
      { path: 'book2/cover.jpg', data: new TextEncoder().encode('cover') },
      { path: 'book2/chapter1.pdf', data: new TextEncoder().encode('ch1') },
    ])

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(2)
    expect(result.packs.sort()).toEqual(['book1', 'book2'])
    expect(result.errors).toHaveLength(0)

    const book1Data = await storage.read('book1')
    const book2Data = await storage.read('book2')
    expect(book1Data.byteLength).toBeGreaterThan(0)
    expect(book2Data.byteLength).toBeGreaterThan(0)
  })

  it('reports progress during migration', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/page1.png', data: new TextEncoder().encode('p1') },
      { path: 'book1/page2.png', data: new TextEncoder().encode('p2') },
      { path: 'book1/page3.png', data: new TextEncoder().encode('p3') },
    ])

    const progressEvents: Array<{
      currentBook: string
      totalBooks: number
      currentFile: number
      totalFiles: number
    }> = []

    const options: MigrationOptions = {
      onProgress: (progress) => {
        progressEvents.push(progress)
      },
    }

    await migrateToPacks(fs, storage, options)

    expect(progressEvents.length).toBeGreaterThan(0)
    expect(progressEvents[0]?.currentBook).toBe('book1')
    expect(progressEvents[0]?.totalBooks).toBe(1)
    expect(progressEvents[0]?.currentFile).toBe(1)
    expect(progressEvents[0]?.totalFiles).toBe(3)

    const lastEvent = progressEvents[progressEvents.length - 1]
    expect(lastEvent?.currentFile).toBe(3)
    expect(lastEvent?.totalFiles).toBe(3)
  })

  it('validates migrated pack integrity', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/hello.txt', data: new TextEncoder().encode('hello') },
      { path: 'book1/world.txt', data: new TextEncoder().encode('world') },
    ])

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(1)
    expect(result.errors).toHaveLength(0)

    const packData = await storage.read('book1')
    const isValid = await validatePack(packData)
    expect(isValid).toBe(true)
  })

  it('handles empty directory gracefully', async () => {
    const fs = new TestFileSystem([])

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('supports filtering by file type', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/page1.png', data: new TextEncoder().encode('png1') },
      { path: 'book1/page2.png', data: new TextEncoder().encode('png2') },
      { path: 'book1/notes.txt', data: new TextEncoder().encode('notes') },
      { path: 'book1/data.json', data: new TextEncoder().encode('json') },
    ])

    const options: MigrationOptions = {
      filter: (path: string) => path.endsWith('.png'),
    }

    const result = await migrateToPacks(fs, storage, options)

    expect(result.packs).toHaveLength(1)

    const packData = await storage.read('book1')
    const isValid = await validatePack(packData)
    expect(isValid).toBe(true)
  })

  it('groups files by first directory segment', async () => {
    const fs = new TestFileSystem([
      { path: 'alpha/file1.txt', data: new TextEncoder().encode('a1') },
      { path: 'beta/file1.txt', data: new TextEncoder().encode('b1') },
      { path: 'gamma/nested/file1.txt', data: new TextEncoder().encode('g1') },
    ])

    const result = await migrateToPacks(fs, storage)

    expect(result.packs).toHaveLength(3)
    expect(result.packs.sort()).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('validatePack', () => {
  it('returns true for valid pack data', async () => {
    const fs = new TestFileSystem([
      { path: 'book1/test.txt', data: new TextEncoder().encode('test') },
    ])

    const storage = new MemoryPackStorage()
    await migrateToPacks(fs, storage)

    const packData = await storage.read('book1')
    const isValid = await validatePack(packData)
    expect(isValid).toBe(true)
  })

  it('returns false for invalid data', async () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer
    const isValid = await validatePack(invalidData)
    expect(isValid).toBe(false)
  })
})
