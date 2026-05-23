# Agent Context: @megablacklabel/opfspack

## What This Package Does

OPFS-based pack file system for browser environments. Groups files into binary packages with Unity Asset Bundle-inspired architecture.

## Architecture Decisions

### Why Custom Binary Format?
- Optimized for browser OPFS random access
- Smaller overhead than zip/tar for our use case
- Full control over feature set (identity binding, compression choice)

### Why Index-at-End?
- Fast format validation (header at start)
- Seek to `fileSize - indexSize` to read index first
- Enables O(1) entry lookup without full file scan

### Why Arrow IPC + SAB?
- NOT used as pack format (OPFS remains custom binary)
- Used as Worker <-> Main Thread communication layer
- Zero-copy binary data transfer via SharedArrayBuffer
- Comlink wraps Arrow IPC transport naturally

### Identity Binding Security Model
- Anchor: Google OAuth `sub` (immutable, not email)
- Key derivation: PBKDF2(sub + salt) → HKDF(packId) → AES-GCM 256-bit
- Keys are non-extractable, memory-only, never persisted
- Each entry encrypted with unique 12-byte IV

## Code Patterns

### PackBuilder → PackReader → PackManager

```
PackBuilder (creates binary pack)
  ↓
PackReader (parses, random access)
  ↓
PackManager (orchestrates, OPFS-aware)
```

### PackStorage Interface

```typescript
interface PackStorage {
  write(packId: string, data: ArrayBuffer): Promise<void>
  read(packId: string): Promise<ArrayBuffer>
  delete(packId: string): Promise<void>
  list(): Promise<string[]>
  exists(packId: string): Promise<boolean>
}
```

Implementations:
- `MemoryPackStorage` - In-memory (tests)
- `OPFSPackStorage` - OPFS file system
- `SQLitePackStorage` - SQLite index (metadata only)

### Worker Communication Pattern

```typescript
// Main Thread
const proxy = await packWorker.readEntryAsProxy('book-123', 'page_001.webp')
const bookPage = decodePackEntry(proxy.data)
const imageData = new Uint8Array(proxy.sab) // Zero-copy

// Worker (pack-worker.ts)
export async function readEntryAsProxy(packId: string, entryPath: string) {
  const packReader = await openPackReader(packId)
  const entryInfo = packReader.getEntryInfo(entryPath)
  const data = packReader.readEntry(entryPath)
  const ipcData = encodePackEntry({...entryInfo})
  const sab = allocateSAB(data.byteLength)
  copyToSAB(new Uint8Array(data), sab)
  return createArrowProxy(ipcData, sab)
}
```

## Testing Strategy

### Test File Locations
- `src/__tests__/format.test.ts` - Binary format serialization
- `src/__tests__/builder.test.ts` - PackBuilder unit tests
- `src/__tests__/reader.test.ts` - PackReader unit tests
- `src/__tests__/manager.test.ts` - PackManager orchestration
- `src/__tests__/opfs-storage.test.ts` - OPFS integration
- `src/__tests__/migration.test.ts` - Migration utility
- `src/__tests__/wasm-bridge.test.ts` - WASM integration
- `src/__tests__/sqlite-storage.test.ts` - SQLite integration
- `src/__tests__/cache.test.ts` - LRU cache tests
- `src/__tests__/integration.test.ts` - End-to-end
- `src/__tests__/fuzz.test.ts` - Corrupted pack handling

### Coverage Goal: >90%

### TDD Approach
1. Write failing test
2. Verify it fails for expected reason
3. Write minimal implementation
4. Verify it passes
5. Refactor if needed

## Common Tasks for Agents

### Add New Entry Type
1. Update `EntryFlags` in `src/format.ts`
2. Add handling in `PackBuilder.processEntries()` in `src/builder.ts`
3. Add handling in `PackReader.readEntry()` in `src/reader.ts`
4. Add tests in `src/__tests__/builder.test.ts` and `src/__tests__/reader.test.ts`

### Add New Storage Backend
1. Implement `PackStorage` interface
2. Add tests in `src/__tests__/`
3. Export from `src/index.ts`

### Add New Compression Algorithm
1. Add Rust crate to `wasm/Cargo.toml` (pure Rust only, no C dependencies)
2. Implement compress/decompress functions in `wasm/src/lib.rs`
3. Export via `wasm-bindgen`
4. Add JS fallback in `src/wasm-bridge.ts`
5. Update `PackBuilder` and `PackReader`
6. Add benchmarks comparing to existing algorithms

### Bump Format Version
1. Update `FORMAT_VERSION` constant in `src/format.ts`
2. Update `PackReader` version check
3. Update tests

## Dependency Map

```
opfspack
├── wasm/                    # Rust → WASM
│   ├── crc32fast           # SIMD CRC-32
│   ├── aes-gcm             # Encryption
│   └── lz4_flex            # Compression
├── src/
│   ├── format.ts           # Binary format constants
│   ├── builder.ts          # Pack assembly
│   ├── reader.ts           # Pack parsing + cache
│   ├── manager.ts          # Orchestration
│   ├── wasm-bridge.ts      # WASM ↔ JS bridge
│   ├── cache.ts            # LRU cache
│   ├── auth/
│   │   └── identity-key.ts # Web Crypto key derivation
│   ├── db/
│   │   ├── schema.ts       # Drizzle ORM schema
│   │   ├── client.ts       # wa-sqlite client
│   │   └── storage.ts      # SQLitePackStorage
│   └── arrow/              # Worker communication
│       ├── worker.ts
│       └── client.ts
├── fflate                  # JS compression fallback
└── comlink                 # Worker RPC
```

## Error Handling

### Error Hierarchy
```
PackError (base)
├── PackVersionError      # Unsupported format version
├── PackCorruptedError    # CRC/checksum failure
└── PackNotFoundError     # Pack missing from storage
```

### Debug Logging Points
- WASM initialization failure (falls back to JS)
- Identity binding key derivation
- Index CRC validation
- Cache hit/miss (optional)

## Known Limitations

- WASM compression requires `wasm-pack build` before use
- OPFS requires cross-origin isolation for SAB

## Rust/WASM Development

### Build
```bash
cd packages/opfspack/wasm
wasm-pack build --target web --out-dir pkg
```

### Pure Rust Crates Only
- ✅ `crc32fast` - Pure Rust
- ✅ `aes-gcm` - Pure Rust
- ✅ `lz4_flex` - Pure Rust
- ❌ `zstd` - C dependency, WASM incompatible

### Bundle Size Impact
- WASM + JS glue: ~65KB (compressed)
- LZ4 adds ~10KB
- Total overhead: <100KB

## Performance Targets

- Pack creation: <2x slower than loose file writes
- Random access: <10ms per entry (excluding I/O)
- Page turn latency: <50ms with prefetch
- Memory: <5MB peak for 100MB entry streaming
- Cache hit rate: >80% for sequential reading

## Phase 3 Roadmap

Phase 2 での基盤構築（Rust/WASM, SQLite, Cache, Identity Binding）を完了した後、以下の未実装機能を段階的に実装する。

### 3-A: Compression Level

PackBuilder で可変圧縮レベルをサポート。

```typescript
interface PackBuilderOptions {
  compress?: boolean
  compressionLevel?: number // 0-9, default: 6
}
```

- fflate の `deflateSync` に `level` オプションを渡す
- レベルごとの圧縮率・速度のバランスをテストで検証
- **テスト方針**: 同一データをレベル0とレベル9で圧縮し、サイズ差を検証

### 3-B: Sorted Index

インデックスエントリをパス順（辞書順）でソートして書き込む。

- `PackBuilder.calculateOffsets()` 前に `entries.sort((a, b) => a.path.localeCompare(b.path))`
- ソート済みインデックスにより二分探索が可能に（将来の拡張）
- バイナリフォーマット自体は変わらない（並び順のみ）
- **テスト方針**: 複数エントリを追加後、build したパックのインデックスがパス順に並んでいることを確認

### 3-C: Progress Callbacks

パック作成・読み出しの進捗通知。

```typescript
interface PackProgress {
  phase: 'scanning' | 'packing' | 'indexing' | 'finalizing'
  current: number
  total: number
  bytesProcessed: number
  bytesTotal: number
}

interface PackBuilderOptions {
  onProgress?: (progress: PackProgress) => void
}
```

- `processEntries()` 中に各エントリ処理後にコールバック
- buildToOPFS() ではストリーミング書き込み中にも通知
- **テスト方針**: コールバックが期待通りの phase と進捗で呼ばれることを確認

### Phase 3 実装順序

1. **3-A** → 最も独立していて影響範囲が小さい
2. **3-B** → インデックス構造に変更あり（後方互換維持）
3. **3-C** → インターフェース変更（オプショナルなので破壊的ではない）

## Migration Notes

Since the package is pre-release, there is no migration path between versions. The current format is v2 with IV field support.

## Git Workflow

```bash
# All work on feature/opfs-pack branch
gh pr checkout -b feature/opfs-pack

# Atomic commits
gh pr commit -m "feat(pack): add X"

# Before PR
bun run typecheck
bun run test:run
```
