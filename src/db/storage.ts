import { eq, and } from 'drizzle-orm'
import type { PackStorage } from '../manager.js'
import { packs, packEntries } from './schema.js'
import { createPackIndexDB } from './client.js'
import type { PackMetadata, PackEntryInfo } from '../types.js'

export class SQLitePackStorage implements PackStorage {
  private db: Awaited<ReturnType<typeof createPackIndexDB>>['db'] | null = null
  private client: Awaited<ReturnType<typeof createPackIndexDB>> | null = null
  private initialized = false

  async init() {
    if (this.initialized) return
    this.client = await createPackIndexDB()
    this.db = this.client.db
    this.initialized = true

    await this.createTables()
  }

  private async createTables() {
    if (!this.db) return

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS packs (
        pack_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        flags INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        total_size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        identity_bound INTEGER NOT NULL DEFAULT 0,
        opfs_path TEXT NOT NULL
      )
    `)

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS pack_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        flags INTEGER NOT NULL DEFAULT 0,
        iv BLOB,
        FOREIGN KEY (pack_id) REFERENCES packs(pack_id) ON DELETE CASCADE
      )
    `)

    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_entries_pack ON pack_entries(pack_id)
    `)

    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_entries_path ON pack_entries(pack_id, path)
    `)
  }

  async write(_packId: string, _data: ArrayBuffer): Promise<void> {
    throw new Error('SQLitePackStorage does not store binary data directly. Use underlying PackStorage.')
  }

  async read(_packId: string): Promise<ArrayBuffer> {
    throw new Error('SQLitePackStorage does not store binary data directly. Use underlying PackStorage.')
  }

  async delete(packId: string): Promise<void> {
    if (!this.db) return
    await this.db.delete(packEntries).where(eq(packEntries.packId, packId))
    await this.db.delete(packs).where(eq(packs.packId, packId))
  }

  async list(): Promise<string[]> {
    if (!this.db) return []
    const rows = await this.db.select({ packId: packs.packId }).from(packs)
    return rows.map((r) => r.packId)
  }

  async exists(packId: string): Promise<boolean> {
    if (!this.db) return false
    const rows = await this.db.select().from(packs).where(eq(packs.packId, packId))
    return rows.length > 0
  }

  async insertPack(
    packId: string,
    metadata: PackMetadata,
    totalSize: number,
    opfsPath: string,
    identityBound: boolean
  ): Promise<void> {
    if (!this.db) return
    await this.db.insert(packs).values({
      packId,
      version: metadata.version,
      flags: metadata.flags,
      entryCount: metadata.entryCount,
      totalSize,
      createdAt: metadata.createdAt.getTime(),
      identityBound: identityBound ? 1 : 0,
      opfsPath,
    })
  }

  async insertEntries(packId: string, entries: PackEntryInfo[]): Promise<void> {
    if (!this.db || entries.length === 0) return
    
    const values = entries.map((entry) => ({
      packId,
      path: entry.path,
      mimeType: entry.mimeType,
      size: entry.size,
      compressedSize: entry.compressedSize,
      offset: Number(entry.offset),
      flags: entry.flags,
      iv: entry.iv ?? null,
    }))

    await this.db.insert(packEntries).values(values)
  }

  async getPackMetadata(packId: string): Promise<PackMetadata | undefined> {
    if (!this.db) return undefined
    const rows = await this.db.select().from(packs).where(eq(packs.packId, packId))
    if (rows.length === 0) return undefined
    
    const row = rows[0]
    return {
      version: row.version,
      flags: row.flags,
      entryCount: row.entryCount,
      createdAt: new Date(row.createdAt),
    }
  }

  async getPackEntries(packId: string): Promise<PackEntryInfo[]> {
    if (!this.db) return []
    const rows = await this.db.select().from(packEntries).where(eq(packEntries.packId, packId))
    
    return rows.map((row) => ({
      path: row.path,
      mimeType: row.mimeType,
      size: row.size,
      compressedSize: row.compressedSize,
      flags: row.flags,
      offset: BigInt(row.offset),
    }))
  }

  async findEntry(packId: string, path: string): Promise<PackEntryInfo | undefined> {
    if (!this.db) return undefined
    const rows = await this.db
      .select()
      .from(packEntries)
      .where(and(eq(packEntries.packId, packId), eq(packEntries.path, path)))
    
    if (rows.length === 0) return undefined
    
    const row = rows[0]
    return {
      path: row.path,
      mimeType: row.mimeType,
      size: row.size,
      compressedSize: row.compressedSize,
      flags: row.flags,
      offset: BigInt(row.offset),
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
    }
    this.db = null
    this.initialized = false
  }
}
