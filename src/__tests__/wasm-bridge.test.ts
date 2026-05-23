import { describe, it, expect, beforeAll } from 'vitest'
import {
  crc32,
  parseIndex,
  initCipher,
  encrypt,
  decrypt,
  generateIV,
  wasmAvailable,
} from '../wasm-bridge'

describe('WASM Bridge', () => {
  beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  describe('crc32', () => {
    it('should calculate CRC-32 for known data', async () => {
      const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])
      const result = await crc32(data)
      expect(result).toBe(0xcbf43926)
    })

    it('should calculate CRC-32 for empty data', async () => {
      const data = new Uint8Array(0)
      const result = await crc32(data)
      expect(result).toBe(0)
    })
  })

  describe('parseIndex', () => {
    it('should parse single entry', async () => {
      const data = new Uint8Array([
        0x04, 0x00,
        ...new TextEncoder().encode('test'),
        0x0a, 0x00,
        ...new TextEncoder().encode('text/plain'),
        ...new Uint8Array(new BigUint64Array([100n]).buffer),
        ...new Uint8Array(new BigUint64Array([50n]).buffer),
        ...new Uint8Array(new BigUint64Array([50n]).buffer),
        ...new Uint8Array(new Uint32Array([0]).buffer),
        ...new Uint8Array(12),
      ])

      const entries = await parseIndex(data, 1)
      expect(entries).toHaveLength(1)
      expect(entries[0].path).toBe('test')
      expect(entries[0].mimeType).toBe('text/plain')
      expect(entries[0].offset).toBe(100n)
      expect(entries[0].size).toBe(50n)
      expect(entries[0].compressedSize).toBe(50n)
      expect(entries[0].flags).toBe(0)
      expect(entries[0].iv).toHaveLength(12)
    })

    it('should parse multiple entries', async () => {
      const encoder = new TextEncoder()
      
      const createEntry = (path: string, mime: string) => {
        const pathBytes = encoder.encode(path)
        const mimeBytes = encoder.encode(mime)
        const raw = 2 + pathBytes.length + 2 + mimeBytes.length + 8 + 8 + 8 + 4 + 12
        const aligned = Math.ceil(raw / 8) * 8
        
        const buf = new Uint8Array(aligned)
        let pos = 0
        
        new DataView(buf.buffer).setUint16(pos, pathBytes.length, true)
        pos += 2
        buf.set(pathBytes, pos)
        pos += pathBytes.length
        
        new DataView(buf.buffer).setUint16(pos, mimeBytes.length, true)
        pos += 2
        buf.set(mimeBytes, pos)
        pos += mimeBytes.length
        
        new DataView(buf.buffer).setBigUint64(pos, 0n, true)
        pos += 8
        new DataView(buf.buffer).setBigUint64(pos, 100n, true)
        pos += 8
        new DataView(buf.buffer).setBigUint64(pos, 100n, true)
        pos += 8
        new DataView(buf.buffer).setUint32(pos, 0, true)
        pos += 4
        buf.set(new Uint8Array(12), pos)
        
        return buf
      }
      
      const entry1 = createEntry('file', 'text/html')
      const entry2 = createEntry('image', 'image/webp')
      
      const data = new Uint8Array(entry1.length + entry2.length)
      data.set(entry1, 0)
      data.set(entry2, entry1.length)
      
      const entries = await parseIndex(data, 2)
      
      expect(entries).toHaveLength(2)
      expect(entries[0].path).toBe('file')
      expect(entries[1].path).toBe('image')
    })
  })

  describe('AES-GCM', () => {
    it('should encrypt and decrypt data', async () => {
      if (!wasmAvailable) {
        return
      }

      const key = new Uint8Array(32)
      await initCipher(key)

      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const iv = await generateIV()
      
      const encrypted = await encrypt(plaintext, iv, key)
      expect(encrypted).not.toEqual(plaintext)

      const decrypted = await decrypt(encrypted, iv, key)
      expect(new Uint8Array(decrypted)).toEqual(plaintext)
    })

    it('should generate 12-byte IV', async () => {
      const iv = await generateIV()
      expect(iv).toHaveLength(12)
    })
  })
})
