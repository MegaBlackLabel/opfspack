import { PackBuilder } from './builder.js'
import { PackReader } from './reader.js'
import type { PackOptions, PackMetadata, ReadOptions } from './types.js'
import { PackNotFoundError } from './errors.js'

export interface PackStorage {
  write(packId: string, data: ArrayBuffer): Promise<void>
  read(packId: string): Promise<ArrayBuffer>
  delete(packId: string): Promise<void>
  list(): Promise<string[]>
  exists(packId: string): Promise<boolean>
}

export class MemoryPackStorage implements PackStorage {
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
    if (!this.store.has(packId)) {
      throw new PackNotFoundError(`Pack not found: ${packId}`)
    }
    this.store.delete(packId)
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys())
  }

  async exists(packId: string): Promise<boolean> {
    return this.store.has(packId)
  }
}

export interface PackListEntry {
  packId: string
  metadata: PackMetadata
  entryCount: number
}

export interface PackFile {
  path: string
  data: Uint8Array | ArrayBuffer
  mimeType: string
}

export class PackManager {
  private storage: PackStorage

  constructor(storage?: PackStorage) {
    this.storage = storage ?? new MemoryPackStorage()
  }

  async createPack(
    packId: string,
    files: PackFile[],
    options?: PackOptions,
  ): Promise<void> {
    const builder = new PackBuilder({
      compress: options?.compression === 'deflate',
      identityBinding: options?.identityBinding,
      packId: options?.identityBinding ? packId : undefined,
    })

    for (const file of files) {
      builder.addEntry(file.path, file.data, file.mimeType)
    }

    const pack = await builder.build()
    await this.storage.write(packId, pack)
  }

  async openPack(packId: string): Promise<PackReader> {
    const data = await this.storage.read(packId)
    return PackReader.fromBuffer(data)
  }

  async deletePack(packId: string): Promise<void> {
    if (!(await this.storage.exists(packId))) {
      throw new PackNotFoundError(`Pack not found: ${packId}`)
    }
    await this.storage.delete(packId)
  }

  async listPacks(): Promise<PackListEntry[]> {
    const packIds = await this.storage.list()
    const entries: PackListEntry[] = []

    for (const packId of packIds) {
      try {
        const data = await this.storage.read(packId)
        const reader = PackReader.fromBuffer(data)
        const metadata = reader.metadata
        entries.push({
          packId,
          metadata,
          entryCount: metadata.entryCount,
        })
        reader.close()
      } catch {
        // Skip corrupted or unreadable packs
      }
    }

    return entries
  }

  async readFile(
    packId: string,
    entryPath: string,
    options?: ReadOptions,
  ): Promise<ArrayBuffer> {
    const data = await this.storage.read(packId)
    const reader = PackReader.fromBuffer(data)
    try {
      return await reader.readEntry(entryPath, options)
    } finally {
      reader.close()
    }
  }

  async hasPack(packId: string): Promise<boolean> {
    return this.storage.exists(packId)
  }
}
