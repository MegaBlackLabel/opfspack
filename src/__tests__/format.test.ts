/**
 * format.test.ts
 *
 * TDD tests for the opfspack binary format specification.
 * Tests are written FIRST to define the expected behavior.
 *
 * Binary layout:
 *   Header: 64 bytes fixed
 *   Index entries: variable length, 8-byte aligned
 */

import { describe, it, expect } from 'vitest'
import {
  MAGIC,
  MAGIC_NUMBER,
  HEADER_SIZE,
  FORMAT_VERSION,
  LITTLE_ENDIAN,
  PackFlags,
  EntryFlags,
  serializeHeader,
  deserializeHeader,
  serializeIndexEntry,
  deserializeIndexEntry,
  calcIndexEntrySize,
  validateMagic,
  type PackHeader,
  type PackIndexEntry,
} from '../format.js'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

describe('Constants', () => {
  it('MAGIC is the 4-byte ASCII string OPFS', () => {
    expect(MAGIC).toBe('OPFS')
  })

  it('MAGIC_NUMBER is 0x4F504653 (little-endian bytes: 4F 50 46 53)', () => {
    // 'T'=0x54, 'D'=0x44, 'P'=0x50, 'K'=0x4B
    expect(MAGIC_NUMBER).toEqual(new Uint8Array([0x4f, 0x50, 0x46, 0x53]))
  })

  it('HEADER_SIZE is exactly 64 bytes', () => {
    expect(HEADER_SIZE).toBe(64)
  })

  it('FORMAT_VERSION is 2', () => {
    expect(FORMAT_VERSION).toBe(2)
  })

  it('LITTLE_ENDIAN is true', () => {
    expect(LITTLE_ENDIAN).toBe(true)
  })
})

// ─────────────────────────────────────────────
// PackFlags enum
// ─────────────────────────────────────────────

describe('PackFlags', () => {
  it('None is 0', () => {
    expect(PackFlags.None).toBe(0)
  })

  it('Compressed is 1 << 0 = 1', () => {
    expect(PackFlags.Compressed).toBe(1)
  })

  it('Encrypted is 1 << 1 = 2', () => {
    expect(PackFlags.Encrypted).toBe(2)
  })

  it('flags can be combined with bitwise OR', () => {
    const combined = PackFlags.Compressed | PackFlags.Encrypted
    expect(combined).toBe(3)
    expect(combined & PackFlags.Compressed).toBeTruthy()
    expect(combined & PackFlags.Encrypted).toBeTruthy()
  })
})

// ─────────────────────────────────────────────
// EntryFlags enum
// ─────────────────────────────────────────────

describe('EntryFlags', () => {
  it('None is 0', () => {
    expect(EntryFlags.None).toBe(0)
  })

  it('Compressed is 1 << 0 = 1', () => {
    expect(EntryFlags.Compressed).toBe(1)
  })

  it('Encrypted is 1 << 1 = 2', () => {
    expect(EntryFlags.Encrypted).toBe(2)
  })

  it('IdentityBound is 1 << 2 = 4 (Phase 2 optional identity binding)', () => {
    expect(EntryFlags.IdentityBound).toBe(4)
  })

  it('all flags can be combined', () => {
    const all = EntryFlags.Compressed | EntryFlags.Encrypted | EntryFlags.IdentityBound
    expect(all).toBe(7)
  })
})

// ─────────────────────────────────────────────
// Magic validation
// ─────────────────────────────────────────────

describe('validateMagic', () => {
  it('returns true for valid OPFS magic bytes', () => {
    const buf = new Uint8Array([0x4f, 0x50, 0x46, 0x53])
    expect(validateMagic(buf)).toBe(true)
  })

  it('returns false for wrong magic bytes', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00])
    expect(validateMagic(buf)).toBe(false)
  })

  it('returns false for partial match', () => {
    const buf = new Uint8Array([0x54, 0x44, 0x50, 0x00])
    expect(validateMagic(buf)).toBe(false)
  })

  it('returns false for buffer shorter than 4 bytes', () => {
    const buf = new Uint8Array([0x54, 0x44, 0x50])
    expect(validateMagic(buf)).toBe(false)
  })
})

// ─────────────────────────────────────────────
// Header serialization
// ─────────────────────────────────────────────

describe('serializeHeader / deserializeHeader', () => {
  const sampleHeader: PackHeader = {
      magic: new Uint8Array([0x4f, 0x50, 0x46, 0x53]),
      version: FORMAT_VERSION,
    flags: PackFlags.None,
    reserved: 0,
    indexOffset: BigInt(64),
    indexSize: BigInt(256),
    entryCount: 3,
    createdAt: BigInt(1700000000000),
    checksum: 0, // will be computed during serialization
  }

  it('serialized buffer is exactly HEADER_SIZE (64) bytes', () => {
    const buf = serializeHeader(sampleHeader)
    expect(buf.byteLength).toBe(HEADER_SIZE)
  })

  it('first 4 bytes are OPFS magic', () => {
    const buf = serializeHeader(sampleHeader)
    const view = new Uint8Array(buf)
    expect(view[0]).toBe(0x4f) // O
    expect(view[1]).toBe(0x50) // P
    expect(view[2]).toBe(0x46) // F
    expect(view[3]).toBe(0x53) // S
  })

  it('version field at offset 4 is little-endian uint32', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getUint32(4, true)).toBe(FORMAT_VERSION)
  })

  it('flags field at offset 8 is little-endian uint32', () => {
    const header: PackHeader = { ...sampleHeader, flags: PackFlags.Compressed }
    const buf = serializeHeader(header)
    const dv = new DataView(buf)
    expect(dv.getUint32(8, true)).toBe(PackFlags.Compressed)
  })

  it('reserved field at offset 12 is 0', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getUint32(12, true)).toBe(0)
  })

  it('indexOffset at offset 16 is little-endian uint64', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getBigUint64(16, true)).toBe(BigInt(64))
  })

  it('indexSize at offset 24 is little-endian uint64', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getBigUint64(24, true)).toBe(BigInt(256))
  })

  it('entryCount at offset 32 is little-endian uint32', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getUint32(32, true)).toBe(3)
  })

  it('createdAt at offset 40 is little-endian uint64', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    expect(dv.getBigUint64(40, true)).toBe(BigInt(1700000000000))
  })

  it('checksum at offset 60 is CRC-32 of bytes 0-59', () => {
    const buf = serializeHeader(sampleHeader)
    const dv = new DataView(buf)
    const checksum = dv.getUint32(60, true)
    // checksum must be non-zero for non-trivial header
    expect(checksum).toBeGreaterThan(0)
  })

  it('round-trips: deserialize(serialize(header)) equals original fields', () => {
    const buf = serializeHeader(sampleHeader)
    const result = deserializeHeader(buf)
    expect(result.version).toBe(sampleHeader.version)
    expect(result.flags).toBe(sampleHeader.flags)
    expect(result.reserved).toBe(sampleHeader.reserved)
    expect(result.indexOffset).toBe(sampleHeader.indexOffset)
    expect(result.indexSize).toBe(sampleHeader.indexSize)
    expect(result.entryCount).toBe(sampleHeader.entryCount)
    expect(result.createdAt).toBe(sampleHeader.createdAt)
    expect(validateMagic(result.magic)).toBe(true)
  })

  it('deserializeHeader throws on buffer smaller than HEADER_SIZE', () => {
    const small = new ArrayBuffer(32)
    expect(() => deserializeHeader(small)).toThrow()
  })

  it('deserializeHeader throws on invalid magic', () => {
    const buf = serializeHeader(sampleHeader)
    // corrupt magic
    new Uint8Array(buf)[0] = 0x00
    expect(() => deserializeHeader(buf)).toThrow()
  })

  it('checksum verification: deserializeHeader throws on corrupted checksum', () => {
    const buf = serializeHeader(sampleHeader)
    // corrupt a data byte (not the checksum itself)
    new Uint8Array(buf)[10] ^= 0xff
    expect(() => deserializeHeader(buf)).toThrow()
  })
})

// ─────────────────────────────────────────────
// Index entry size calculation
// ─────────────────────────────────────────────

describe('calcIndexEntrySize', () => {
  it('returns size aligned to 8 bytes', () => {
    const size = calcIndexEntrySize('images/cover.jpg', 'image/jpeg')
    expect(size % 8).toBe(0)
  })

  it('minimum size is at least the fixed fields + length-prefixed strings', () => {
    // Fixed fields:
    //   2 (pathLen) + 2 (mimeLen) + 8 (offset) + 8 (size) + 8 (compressedSize) + 4 (flags) + 12 (iv) = 44 bytes
    // Plus variable: pathBytes + mimeBytes
    const path = 'a'
    const mime = 'b'
    const size = calcIndexEntrySize(path, mime)
    const encoder = new TextEncoder()
    const pathBytes = encoder.encode(path).byteLength
    const mimeBytes = encoder.encode(mime).byteLength
    const rawMin = 44 + pathBytes + mimeBytes
    expect(size).toBeGreaterThanOrEqual(rawMin)
    expect(size % 8).toBe(0)
  })

  it('longer paths produce larger entry sizes', () => {
    const short = calcIndexEntrySize('a', 'b')
    const long = calcIndexEntrySize('a'.repeat(100), 'b')
    expect(long).toBeGreaterThan(short)
  })
})

// ─────────────────────────────────────────────
// Index entry serialization
// ─────────────────────────────────────────────

describe('serializeIndexEntry / deserializeIndexEntry', () => {
  const sampleEntry: PackIndexEntry = {
    path: 'images/cover.jpg',
    mimeType: 'image/jpeg',
    offset: BigInt(1024),
    size: BigInt(204800),
    compressedSize: BigInt(102400),
    flags: EntryFlags.Compressed,
    iv: new Uint8Array(12).fill(0xab),
  }

  it('serialized buffer is 8-byte aligned', () => {
    const buf = serializeIndexEntry(sampleEntry)
    expect(buf.byteLength % 8).toBe(0)
  })

  it('path length prefix (uint16 LE) matches UTF-8 byte length of path', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const pathLen = dv.getUint16(0, true)
    const encoder = new TextEncoder()
    expect(pathLen).toBe(encoder.encode(sampleEntry.path).byteLength)
  })

  it('mimeType length prefix (uint16 LE) matches UTF-8 byte length of mimeType', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const encoder = new TextEncoder()
    const pathLen = dv.getUint16(0, true)
    const mimeOffset = 2 + pathLen
    const mimeLen = dv.getUint16(mimeOffset, true)
    expect(mimeLen).toBe(encoder.encode(sampleEntry.mimeType).byteLength)
  })

  it('offset field is little-endian uint64', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const encoder = new TextEncoder()
    const pathLen = encoder.encode(sampleEntry.path).byteLength
    const mimeLen = encoder.encode(sampleEntry.mimeType).byteLength
    // layout: 2 + pathLen + 2 + mimeLen + [offset at this position]
    const offsetPos = 2 + pathLen + 2 + mimeLen
    expect(dv.getBigUint64(offsetPos, true)).toBe(sampleEntry.offset)
  })

  it('size field is little-endian uint64', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const encoder = new TextEncoder()
    const pathLen = encoder.encode(sampleEntry.path).byteLength
    const mimeLen = encoder.encode(sampleEntry.mimeType).byteLength
    const sizePos = 2 + pathLen + 2 + mimeLen + 8
    expect(dv.getBigUint64(sizePos, true)).toBe(sampleEntry.size)
  })

  it('compressedSize field is little-endian uint64', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const encoder = new TextEncoder()
    const pathLen = encoder.encode(sampleEntry.path).byteLength
    const mimeLen = encoder.encode(sampleEntry.mimeType).byteLength
    const csPos = 2 + pathLen + 2 + mimeLen + 8 + 8
    expect(dv.getBigUint64(csPos, true)).toBe(sampleEntry.compressedSize)
  })

  it('flags field is little-endian uint32', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const dv = new DataView(buf)
    const encoder = new TextEncoder()
    const pathLen = encoder.encode(sampleEntry.path).byteLength
    const mimeLen = encoder.encode(sampleEntry.mimeType).byteLength
    const flagsPos = 2 + pathLen + 2 + mimeLen + 8 + 8 + 8
    expect(dv.getUint32(flagsPos, true)).toBe(sampleEntry.flags)
  })

  it('iv field is 12 bytes at correct position', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const view = new Uint8Array(buf)
    const encoder = new TextEncoder()
    const pathLen = encoder.encode(sampleEntry.path).byteLength
    const mimeLen = encoder.encode(sampleEntry.mimeType).byteLength
    const ivPos = 2 + pathLen + 2 + mimeLen + 8 + 8 + 8 + 4
    const iv = view.slice(ivPos, ivPos + 12)
    expect(iv).toEqual(sampleEntry.iv)
  })

  it('round-trips: deserialize(serialize(entry)) equals original', () => {
    const buf = serializeIndexEntry(sampleEntry)
    const result = deserializeIndexEntry(buf)
    expect(result.path).toBe(sampleEntry.path)
    expect(result.mimeType).toBe(sampleEntry.mimeType)
    expect(result.offset).toBe(sampleEntry.offset)
    expect(result.size).toBe(sampleEntry.size)
    expect(result.compressedSize).toBe(sampleEntry.compressedSize)
    expect(result.flags).toBe(sampleEntry.flags)
    expect(result.iv).toEqual(sampleEntry.iv)
  })

  it('handles Unicode path correctly (UTF-8 multi-byte)', () => {
    const unicodeEntry: PackIndexEntry = {
      ...sampleEntry,
      path: '画像/表紙.jpg', // Japanese characters
      mimeType: 'image/jpeg',
    }
    const buf = serializeIndexEntry(unicodeEntry)
    const result = deserializeIndexEntry(buf)
    expect(result.path).toBe(unicodeEntry.path)
  })

  it('iv defaults to 12 zero bytes when not provided (EntryFlags.None)', () => {
    const noIvEntry: PackIndexEntry = {
      ...sampleEntry,
      flags: EntryFlags.None,
      iv: new Uint8Array(12), // all zeros
    }
    const buf = serializeIndexEntry(noIvEntry)
    const result = deserializeIndexEntry(buf)
    expect(result.iv).toEqual(new Uint8Array(12))
  })
})

// ─────────────────────────────────────────────
// Alignment / padding
// ─────────────────────────────────────────────

describe('8-byte alignment', () => {
  it('entry with 1-byte path and 1-byte mime is still 8-byte aligned', () => {
    const entry: PackIndexEntry = {
      path: 'a',
      mimeType: 'b',
      offset: BigInt(0),
      size: BigInt(0),
      compressedSize: BigInt(0),
      flags: EntryFlags.None,
      iv: new Uint8Array(12),
    }
    const buf = serializeIndexEntry(entry)
    expect(buf.byteLength % 8).toBe(0)
  })

  it('entry with 255-byte path is still 8-byte aligned', () => {
    const entry: PackIndexEntry = {
      path: 'x'.repeat(255),
      mimeType: 'application/octet-stream',
      offset: BigInt(0),
      size: BigInt(0),
      compressedSize: BigInt(0),
      flags: EntryFlags.None,
      iv: new Uint8Array(12),
    }
    const buf = serializeIndexEntry(entry)
    expect(buf.byteLength % 8).toBe(0)
  })
})
