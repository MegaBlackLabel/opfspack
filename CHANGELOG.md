# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-23

### Added

- Initial release of `@megablacklabel/opfspack`
- PackBuilder: binary pack creation with optional Deflate/LZ4 compression
- PackReader: O(1) random access via index table
- PackManager: orchestration layer with pluggable PackStorage backends
- OPFSPackStorage: Origin Private File System persistence
- MemoryPackStorage: in-memory storage for tests
- SQLitePackStorage: metadata index via wa-sqlite
- Identity binding: AES-GCM encryption keyed to Google OAuth `sub`
- Arrow IPC + SharedArrayBuffer zero-copy Worker communication
- LRU cache with prefetch for sequential read optimization
- WASM bridge for LZ4 decompression and SIMD CRC-32
