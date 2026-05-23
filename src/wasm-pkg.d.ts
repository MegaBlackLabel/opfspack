declare module '../wasm/pkg/opfspack_wasm' {
  export default function initWasm(): Promise<void>

  export function crc32_wasm(data: Uint8Array): number

  export class PackIndexParser {
    static parse_index(data: Uint8Array, entryCount: number): Array<{
      path: string
      mime_type: string
      offset: bigint
      size: bigint
      compressed_size: bigint
      flags: number
      iv: Uint8Array
    }>
  }

  export class AesGcmCipher {
    static new(key: Uint8Array): AesGcmCipher
    encrypt(plaintext: Uint8Array, iv: Uint8Array): Uint8Array
    decrypt(ciphertext: Uint8Array, iv: Uint8Array): Uint8Array
  }

  export function generate_random_iv(): Uint8Array
}
