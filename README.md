# @megablacklabel/opfspack

Browser-native pack file system for OPFS (Origin Private File System). Inspired by Unity Asset Bundle architecture.

## Overview

`opfspack` groups related files into a single binary package, solving common OPFS issues:

- **Many small files** → One pack file
- **No atomicity** → Atomic pack operations
- **Hard to backup** → Single file transfer
- **Inefficient random access** → O(1) entry lookup
- **Storage fragmentation** → Single large allocation

## Quick Start

```typescript
import { PackManager, MemoryPackStorage } from '@megablacklabel/opfspack'

const manager = new PackManager(new MemoryPackStorage())

// Create pack
const imageData = new Uint8Array([/* ... */])
await manager.createPack('book-123', [
  { path: 'cover.webp', data: imageData, mimeType: 'image/webp' },
])

// Read pack
const page = await manager.readFile('book-123', 'cover.webp')
```

## Installation

This package is published to **GitHub Packages**.

Add the following to your `.npmrc` before installing:

```
@megablacklabel:registry=https://npm.pkg.github.com
```

Install via Bun (requires GitHub Packages registry config):

```bash
bun add @megablacklabel/opfspack
```

Basic import:

```typescript
import { PackManager, MemoryPackStorage } from '@megablacklabel/opfspack'
```

## Architecture

```
┌─────────────────┬──────────────────┬─────────────────┐
│     HEADER      │      BODY        │  INDEX TABLE    │
│   (64 bytes)    │  (variable size) │  (variable size)│
├─────────────────┴──────────────────┴─────────────────┤
│                                                      │
│  Header: magic (OPFS), version, flags,               │
│          indexOffset, indexSize, entryCount          │
│                                                      │
│  Body: Raw/compressed entry data back-to-back        │
│                                                      │
│  Index: Array of { path, offset, size, flags, iv }   │
│         + CRC-32 checksum                            │
└──────────────────────────────────────────────────────┘
```

## Features

### Random Access
Read any entry in O(1) via index table.

### Optional Compression
- Deflate (JS: fflate)
- LZ4 (Rust/WASM)

### Optional Identity Binding
Bind packs to Gmail identity via Google OAuth `sub`:

```typescript
await manager.createPack('book-123', files, {
  identityBinding: true,
  sub: user.sub,  // Google OAuth sub claim
})
```

Packs are encrypted with AES-GCM. Only the same Gmail account can decrypt.

### Arrow IPC + SAB Worker Communication
Zero-copy transfer between Worker and Main Thread via SharedArrayBuffer.

### SQLite Pack Index
Fast metadata queries without parsing pack files:

```typescript
import { SQLitePackStorage } from '@megablacklabel/opfspack'

const indexDb = new SQLitePackStorage()
await indexDb.init()

// O(1) SQL query instead of OPFS directory scan
const packs = await indexDb.list()
const entries = await indexDb.getPackEntries('book-123')
```

### LRU Cache + Prefetch
PackReader includes 50MB LRU cache:

```typescript
const reader = PackReader.fromBuffer(buffer)

// Prefetch adjacent pages
await reader.prefetch([
  'pages/page_002.webp',
  'pages/page_003.webp',
])

// Cached read
const page = await reader.readEntry('pages/page_002.webp') // <50ms
```

## API Reference

### PackBuilder

```typescript
class PackBuilder {
  constructor(options?: {
    compress?: boolean
    identityBinding?: boolean
    sub?: string
    packId?: string
  })

  addEntry(path: string, data: Uint8Array, mimeType: string): void
  async build(): Promise<ArrayBuffer>
}
```

### PackReader

```typescript
class PackReader {
  static fromBuffer(buffer: ArrayBuffer): PackReader
  static async fromOPFS(handle: FileSystemFileHandle): Promise<PackReader>

  get metadata(): PackMetadata
  hasEntry(path: string): boolean
  getEntryInfo(path: string): PackEntryInfo | undefined
  async readEntry(path: string, options?: ReadOptions): Promise<ArrayBuffer>
  async readEntryRange(path: string, start: number, end: number): Promise<ArrayBuffer>
  async prefetch(paths: string[]): Promise<void>
  listEntries(): PackEntryInfo[]
}
```

### PackManager

```typescript
class PackManager {
  constructor(storage: PackStorage)

  async createPack(packId: string, files: PackFile[], options?: PackOptions): Promise<void>
  async openPack(packId: string): Promise<PackReader>
  async deletePack(packId: string): Promise<void>
  async listPacks(): Promise<PackListEntry[]>
  async readFile(packId: string, entryPath: string): Promise<ArrayBuffer>
}
```

## Binary Format

| Field | Size | Description |
|-------|------|-------------|
| Magic | 4 bytes | `OPFS` (0x4F504653) |
| Version | 4 bytes | Format version (2) |
| Flags | 4 bytes | Global pack flags |
| Reserved | 4 bytes | Padding |
| Index Offset | 8 bytes | Byte offset to index table |
| Index Size | 8 bytes | Byte size of index table |
| Entry Count | 4 bytes | Number of entries |
| Reserved | 4 bytes | Padding |
| Created At | 8 bytes | Unix timestamp (ms) |
| Reserved | 12 bytes | Padding |
| Checksum | 4 bytes | CRC-32 of header bytes 0-59 |

**Index Entry:**
- Path length (2 bytes)
- Path (variable)
- MIME type length (2 bytes)
- MIME type (variable)
- Offset (8 bytes)
- Size (8 bytes)
- Compressed size (8 bytes)
- Flags (4 bytes)
- IV (12 bytes, AES-GCM nonce)
- Padding to 8-byte alignment

## Development

```bash
# Build WASM
bun run wasm:build

# Build package
bun run build

# Type check
bun run typecheck

# Run tests
bun run test:run
```

### WASM Note

WASM compression requires building the Rust module before use:

- Target: `wasm32-unknown-unknown`
- Tool: `wasm-pack build --target web --out-dir pkg`

OPFS requires cross-origin isolation for SharedArrayBuffer support.

Bundle size impact: WASM + JS glue ~65KB compressed, LZ4 adds ~10KB, total <100KB.

## License

[MIT](./LICENSE)
