// OPFS Pack System - Core Exports

export const VERSION = '0.1.0'

export type {
  PackEntryInfo,
  PackMetadata,
  PackWorkerAPI,
  PackEntryProxy,
} from './types.js'

export type {
  PackProgress,
  PackOptions,
  ReadOptions,
  EntryOptions,
} from './types.js'

export {
  PackError,
  PackVersionError,
  PackCorruptedError,
  PackNotFoundError,
} from './errors.js'

export type {
  PackStorage,
  PackListEntry,
  PackFile,
} from './manager.js'

export {
  PackManager,
  MemoryPackStorage,
} from './manager.js'

export { OPFSPackStorage } from './storage/opfs.js'

export type {
  FileSystem,
  MigrationProgress,
  MigrationOptions,
  MigrationResult,
} from './migration.js'

export {
  migrateToPacks,
  validatePack,
} from './migration.js'

export {
  crc32,
  parseIndex,
  initCipher,
  encrypt,
  decrypt,
  generateIV,
  wasmAvailable,
  type IndexEntry,
  type CryptoResult,
} from './wasm-bridge.js'

export { PackBuilder } from './builder.js'
export { PackReader } from './reader.js'

export { SQLitePackStorage } from './db/storage.js'
export { packs, packEntries } from './db/schema.js'
export { createPackIndexDB } from './db/client.js'
