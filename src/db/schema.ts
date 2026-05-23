import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core'

export const packs = sqliteTable('packs', {
  packId: text('pack_id').primaryKey(),
  version: integer('version').notNull(),
  flags: integer('flags').notNull().default(0),
  entryCount: integer('entry_count').notNull().default(0),
  totalSize: integer('total_size').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  identityBound: integer('identity_bound').notNull().default(0),
  opfsPath: text('opfs_path').notNull(),
})

export const packEntries = sqliteTable('pack_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packId: text('pack_id').notNull(),
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  compressedSize: integer('compressed_size').notNull(),
  offset: integer('offset').notNull(),
  flags: integer('flags').notNull().default(0),
  iv: blob('iv'),
})

export type PackRow = typeof packs.$inferSelect
export type PackEntryRow = typeof packEntries.$inferSelect
