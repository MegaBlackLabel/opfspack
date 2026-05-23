import { describe, it, expect } from 'vitest'
import {
  deriveMasterKey,
  derivePackKey,
  encryptEntry,
  decryptEntry,
} from '../auth/identity-key'

describe('identity-key', () => {
  describe('deriveMasterKey', () => {
    it('same sub produces a CryptoKey', async () => {
      const key = await deriveMasterKey('user-sub-123')
      expect(key).toBeDefined()
      expect(key.type).toBe('secret')
      expect(key.extractable).toBe(false)
    })
  })

  describe('derivePackKey', () => {
    it('same sub + same packId → same derived key bytes (deterministic)', async () => {
      // We can't extract keys, so we verify determinism by encrypting the same
      // plaintext with both keys and checking the ciphertexts decrypt correctly
      const sub = 'user-sub-deterministic'
      const packId = 'pack-abc'

      const master1 = await deriveMasterKey(sub)
      const master2 = await deriveMasterKey(sub)
      const packKey1 = await derivePackKey(master1, packId)
      const packKey2 = await derivePackKey(master2, packId)

      // Encrypt with key1, decrypt with key2 — must succeed if keys are identical
      const plaintext = new TextEncoder().encode('hello determinism')
      const { encrypted, iv } = await encryptEntry(plaintext.buffer, packKey1)
      const decrypted = await decryptEntry(encrypted, iv, packKey2)
      const result = new TextDecoder().decode(decrypted)
      expect(result).toBe('hello determinism')
    })

    it('different sub → different pack key (decrypt fails)', async () => {
      const packId = 'pack-abc'

      const master1 = await deriveMasterKey('user-sub-alice')
      const master2 = await deriveMasterKey('user-sub-bob')
      const packKey1 = await derivePackKey(master1, packId)
      const packKey2 = await derivePackKey(master2, packId)

      const plaintext = new TextEncoder().encode('secret data')
      const { encrypted, iv } = await encryptEntry(plaintext.buffer, packKey1)

      // Decrypting with a different user's key must throw
      await expect(decryptEntry(encrypted, iv, packKey2)).rejects.toThrow()
    })
  })

  describe('encryptEntry / decryptEntry', () => {
    it('encrypt then decrypt returns original data', async () => {
      const master = await deriveMasterKey('user-sub-roundtrip')
      const packKey = await derivePackKey(master, 'pack-roundtrip')

      const original = new TextEncoder().encode('round-trip test data 🔐')
      const { encrypted, iv } = await encryptEntry(original.buffer, packKey)

      expect(encrypted.byteLength).toBeGreaterThan(original.byteLength)
      expect(iv).toHaveLength(12)

      const decrypted = await decryptEntry(encrypted, iv, packKey)
      const result = new TextDecoder().decode(decrypted)
      expect(result).toBe('round-trip test data 🔐')
    })

    it('each encryption produces a different IV (random IV)', async () => {
      const master = await deriveMasterKey('user-sub-iv')
      const packKey = await derivePackKey(master, 'pack-iv')
      const data = new TextEncoder().encode('test').buffer

      const { iv: iv1 } = await encryptEntry(data, packKey)
      const { iv: iv2 } = await encryptEntry(data, packKey)

      // IVs must differ (random)
      expect(iv1).not.toEqual(iv2)
    })

    it('decrypt with wrong key fails', async () => {
      const master1 = await deriveMasterKey('user-sub-wrong-key-1')
      const master2 = await deriveMasterKey('user-sub-wrong-key-2')
      const packKey1 = await derivePackKey(master1, 'pack-x')
      const packKey2 = await derivePackKey(master2, 'pack-x')

      const data = new TextEncoder().encode('sensitive').buffer
      const { encrypted, iv } = await encryptEntry(data, packKey1)

      await expect(decryptEntry(encrypted, iv, packKey2)).rejects.toThrow()
    })
  })
})
