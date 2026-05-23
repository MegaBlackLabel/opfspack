/**
 * Security model:
 * - Identity anchor: Google OAuth `sub` (stable user ID, not email)
 * - Master key: PBKDF2(sub + APP_SALT, APP_SALT, 100_000 iterations, SHA-256)
 * - Pack key:   HKDF(masterKey, salt=packId, info='opfspack-entry-key', SHA-256)
 * - Encryption: AES-GCM 256-bit, random 12-byte IV per operation
 * - Keys are non-extractable and kept in memory only (never persisted)
 */

export const APP_SALT = 'opfspack-v1-identity-salt-2024'
export const PBKDF2_ITERATIONS = 100_000

const enc = new TextEncoder()

export async function deriveMasterKey(sub: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(sub + APP_SALT),
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(APP_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  )

  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
}

export async function derivePackKey(
  masterKey: CryptoKey,
  packId: string,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(packId),
      info: enc.encode('opfspack-entry-key'),
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptEntry(
  data: ArrayBuffer,
  packKey: CryptoKey,
): Promise<{ encrypted: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    packKey,
    data,
  )
  return { encrypted, iv }
}

export async function decryptEntry(
  encrypted: ArrayBuffer,
  iv: Uint8Array,
  packKey: CryptoKey,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, packKey, encrypted)
}
