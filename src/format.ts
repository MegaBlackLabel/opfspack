export const MAGIC = 'OPFS'

export const MAGIC_NUMBER = new Uint8Array([0x4f, 0x50, 0x46, 0x53])

export const HEADER_SIZE = 64

export const FORMAT_VERSION = 2

export const LITTLE_ENDIAN = true

export const enum PackFlags {
  None = 0,
  Compressed = 1 << 0,
  Encrypted = 1 << 1,
}

export const enum EntryFlags {
  None = 0,
  Compressed = 1 << 0,
  Encrypted = 1 << 1,
  IdentityBound = 1 << 2,
}

export interface PackHeader {
  magic: Uint8Array
  version: number
  flags: number
  reserved: number
  indexOffset: bigint
  indexSize: bigint
  entryCount: number
  createdAt: bigint
  checksum: number
}

export interface PackIndexEntry {
  path: string
  mimeType: string
  offset: bigint
  size: bigint
  compressedSize: bigint
  flags: number
  iv: Uint8Array
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function validateMagic(buf: Uint8Array): boolean {
  if (buf.length < 4) return false
  return (
    buf[0] === MAGIC_NUMBER[0] &&
    buf[1] === MAGIC_NUMBER[1] &&
    buf[2] === MAGIC_NUMBER[2] &&
    buf[3] === MAGIC_NUMBER[3]
  )
}

export function serializeHeader(header: PackHeader): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE)
  const view = new Uint8Array(buf)
  const dv = new DataView(buf)

  view[0] = header.magic[0]!
  view[1] = header.magic[1]!
  view[2] = header.magic[2]!
  view[3] = header.magic[3]!

  dv.setUint32(4, header.version, LITTLE_ENDIAN)
  dv.setUint32(8, header.flags, LITTLE_ENDIAN)
  dv.setUint32(12, 0, LITTLE_ENDIAN)
  dv.setBigUint64(16, header.indexOffset, LITTLE_ENDIAN)
  dv.setBigUint64(24, header.indexSize, LITTLE_ENDIAN)
  dv.setUint32(32, header.entryCount, LITTLE_ENDIAN)
  dv.setUint32(36, 0, LITTLE_ENDIAN)
  dv.setBigUint64(40, header.createdAt, LITTLE_ENDIAN)
  dv.setUint32(48, 0, LITTLE_ENDIAN)
  dv.setUint32(52, 0, LITTLE_ENDIAN)
  dv.setUint32(56, 0, LITTLE_ENDIAN)
  dv.setUint32(60, 0, LITTLE_ENDIAN)

  const checksum = crc32(new Uint8Array(buf, 0, 60))
  dv.setUint32(60, checksum, LITTLE_ENDIAN)

  return buf
}

export function deserializeHeader(buf: ArrayBuffer): PackHeader {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`Buffer too small: expected ${HEADER_SIZE}, got ${buf.byteLength}`)
  }

  const view = new Uint8Array(buf)
  const dv = new DataView(buf)

  const magic = new Uint8Array(4)
  magic[0] = view[0]!
  magic[1] = view[1]!
  magic[2] = view[2]!
  magic[3] = view[3]!

  if (!validateMagic(magic)) {
    throw new Error('Invalid magic number: expected OPFS')
  }

  const storedChecksum = dv.getUint32(60, LITTLE_ENDIAN)
  const computedChecksum = crc32(new Uint8Array(buf, 0, 60))
  if (storedChecksum !== computedChecksum) {
    throw new Error(`Checksum mismatch: stored=${storedChecksum}, computed=${computedChecksum}`)
  }

  return {
    magic,
    version: dv.getUint32(4, LITTLE_ENDIAN),
    flags: dv.getUint32(8, LITTLE_ENDIAN),
    reserved: dv.getUint32(12, LITTLE_ENDIAN),
    indexOffset: dv.getBigUint64(16, LITTLE_ENDIAN),
    indexSize: dv.getBigUint64(24, LITTLE_ENDIAN),
    entryCount: dv.getUint32(32, LITTLE_ENDIAN),
    createdAt: dv.getBigUint64(40, LITTLE_ENDIAN),
    checksum: storedChecksum,
  }
}

export function calcIndexEntrySize(path: string, mimeType: string): number {
  const encoder = new TextEncoder()
  const pathBytes = encoder.encode(path).byteLength
  const mimeBytes = encoder.encode(mimeType).byteLength
  const raw = 2 + pathBytes + 2 + mimeBytes + 8 + 8 + 8 + 4 + 12
  return Math.ceil(raw / 8) * 8
}

export function serializeIndexEntry(entry: PackIndexEntry): ArrayBuffer {
  const encoder = new TextEncoder()
  const pathEncoded = encoder.encode(entry.path)
  const mimeEncoded = encoder.encode(entry.mimeType)

  const raw = 2 + pathEncoded.byteLength + 2 + mimeEncoded.byteLength + 8 + 8 + 8 + 4 + 12
  const aligned = Math.ceil(raw / 8) * 8

  const buf = new ArrayBuffer(aligned)
  const view = new Uint8Array(buf)
  const dv = new DataView(buf)

  let pos = 0

  dv.setUint16(pos, pathEncoded.byteLength, LITTLE_ENDIAN)
  pos += 2

  view.set(pathEncoded, pos)
  pos += pathEncoded.byteLength

  dv.setUint16(pos, mimeEncoded.byteLength, LITTLE_ENDIAN)
  pos += 2

  view.set(mimeEncoded, pos)
  pos += mimeEncoded.byteLength

  dv.setBigUint64(pos, entry.offset, LITTLE_ENDIAN)
  pos += 8

  dv.setBigUint64(pos, entry.size, LITTLE_ENDIAN)
  pos += 8

  dv.setBigUint64(pos, entry.compressedSize, LITTLE_ENDIAN)
  pos += 8

  dv.setUint32(pos, entry.flags, LITTLE_ENDIAN)
  pos += 4

  view.set(entry.iv.slice(0, 12), pos)

  return buf
}

export function deserializeIndexEntry(buf: ArrayBuffer): PackIndexEntry {
  const view = new Uint8Array(buf)
  const dv = new DataView(buf)
  const decoder = new TextDecoder()

  let pos = 0

  const pathLen = dv.getUint16(pos, LITTLE_ENDIAN)
  pos += 2

  const path = decoder.decode(view.slice(pos, pos + pathLen))
  pos += pathLen

  const mimeLen = dv.getUint16(pos, LITTLE_ENDIAN)
  pos += 2

  const mimeType = decoder.decode(view.slice(pos, pos + mimeLen))
  pos += mimeLen

  const offset = dv.getBigUint64(pos, LITTLE_ENDIAN)
  pos += 8

  const size = dv.getBigUint64(pos, LITTLE_ENDIAN)
  pos += 8

  const compressedSize = dv.getBigUint64(pos, LITTLE_ENDIAN)
  pos += 8

  const flags = dv.getUint32(pos, LITTLE_ENDIAN)
  pos += 4

  const iv = new Uint8Array(12)
  iv.set(view.slice(pos, pos + 12))

  return { path, mimeType, offset, size, compressedSize, flags, iv }
}
