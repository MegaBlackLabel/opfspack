import initWasm, {
  crc32_wasm,
  PackIndexParser,
  AesGcmCipher,
  generate_random_iv,
} from '../wasm/pkg/opfspack_wasm'
import { crc32 as jsCrc32 } from './format'

let wasmReady: Promise<void> | null = null
let wasmAvailable = false

async function ensureWasmReady(): Promise<void> {
  if (wasmReady === null) {
    wasmReady = initWasm()
      .then(() => {
        wasmAvailable = true
      })
      .catch(() => {
        wasmAvailable = false
      })
  }
  await wasmReady
}

export async function crc32(data: Uint8Array): Promise<number> {
  await ensureWasmReady()
  return wasmAvailable ? crc32_wasm(data) : jsCrc32(data)
}

export interface IndexEntry {
  path: string
  mimeType: string
  offset: bigint
  size: bigint
  compressedSize: bigint
  flags: number
  iv: Uint8Array
}

export async function parseIndex(
  data: Uint8Array,
  entryCount: number
): Promise<IndexEntry[]> {
  await ensureWasmReady()
  
  if (wasmAvailable) {
    return PackIndexParser.parse_index(data, entryCount).map((entry: {
      path: string
      mime_type: string
      offset: bigint
      size: bigint
      compressed_size: bigint
      flags: number
      iv: Uint8Array
    }) => ({
      path: entry.path,
      mimeType: entry.mime_type,
      offset: entry.offset,
      size: entry.size,
      compressedSize: entry.compressed_size,
      flags: entry.flags,
      iv: entry.iv,
    }))
  }
  
  return parseIndexJs(data, entryCount)
}

function parseIndexJs(data: Uint8Array, entryCount: number): IndexEntry[] {
  const entries: IndexEntry[] = []
  let pos = 0
  
  for (let i = 0; i < entryCount; i++) {
    const pathLen = new DataView(data.buffer, data.byteOffset + pos, 2).getUint16(0, true)
    pos += 2
    
    const path = new TextDecoder().decode(data.slice(pos, pos + pathLen))
    pos += pathLen
    
    const mimeLen = new DataView(data.buffer, data.byteOffset + pos, 2).getUint16(0, true)
    pos += 2
    
    const mimeType = new TextDecoder().decode(data.slice(pos, pos + mimeLen))
    pos += mimeLen
    
    const offset = new DataView(data.buffer, data.byteOffset + pos, 8).getBigUint64(0, true)
    pos += 8
    
    const size = new DataView(data.buffer, data.byteOffset + pos, 8).getBigUint64(0, true)
    pos += 8
    
    const compressedSize = new DataView(data.buffer, data.byteOffset + pos, 8).getBigUint64(0, true)
    pos += 8
    
    const flags = new DataView(data.buffer, data.byteOffset + pos, 4).getUint32(0, true)
    pos += 4
    
    const iv = data.slice(pos, pos + 12)
    pos += 12
    
    const rawSize = 2 + pathLen + 2 + mimeLen + 8 + 8 + 8 + 4 + 12
    const aligned = Math.ceil(rawSize / 8) * 8
    pos += aligned - rawSize
    
    entries.push({ path, mimeType, offset, size, compressedSize, flags, iv })
  }
  
  return entries
}

export interface CryptoResult {
  encrypted: Uint8Array
  iv: Uint8Array
}

const cipherMap = new Map<string, AesGcmCipher>()

function getCipherKey(key: Uint8Array): string {
  return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function initCipher(key: Uint8Array): Promise<void> {
  await ensureWasmReady()
  if (wasmAvailable) {
    const cipher = AesGcmCipher.new(key)
    cipherMap.set(getCipherKey(key), cipher)
  }
}

export async function encrypt(plaintext: Uint8Array, iv: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await ensureWasmReady()
  const cipherKey = getCipherKey(key)
  let cipher = cipherMap.get(cipherKey)
  if (wasmAvailable && !cipher) {
    cipher = AesGcmCipher.new(key)
    cipherMap.set(cipherKey, cipher)
  }
  if (wasmAvailable && cipher) {
    return cipher.encrypt(plaintext, iv)
  }
  throw new Error('WASM cipher not available')
}

export async function decrypt(ciphertext: Uint8Array, iv: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await ensureWasmReady()
  const cipherKey = getCipherKey(key)
  let cipher = cipherMap.get(cipherKey)
  if (wasmAvailable && !cipher) {
    cipher = AesGcmCipher.new(key)
    cipherMap.set(cipherKey, cipher)
  }
  if (wasmAvailable && cipher) {
    return cipher.decrypt(ciphertext, iv)
  }
  throw new Error('WASM cipher not available')
}

export async function generateIV(): Promise<Uint8Array> {
  await ensureWasmReady()
  if (wasmAvailable) {
    return generate_random_iv()
  }
  return crypto.getRandomValues(new Uint8Array(12))
}

export { wasmAvailable }
