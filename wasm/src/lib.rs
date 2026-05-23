use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct PackIndexEntry {
    path: String,
    mime_type: String,
    offset: u64,
    size: u64,
    compressed_size: u64,
    flags: u32,
    iv: Vec<u8>,
}

#[wasm_bindgen]
impl PackIndexEntry {
    #[wasm_bindgen(getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn mime_type(&self) -> String {
        self.mime_type.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn offset(&self) -> u64 {
        self.offset
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u64 {
        self.size
    }

    #[wasm_bindgen(getter)]
    pub fn compressed_size(&self) -> u64 {
        self.compressed_size
    }

    #[wasm_bindgen(getter)]
    pub fn flags(&self) -> u32 {
        self.flags
    }

    #[wasm_bindgen(getter)]
    pub fn iv(&self) -> Vec<u8> {
        self.iv.clone()
    }
}

#[wasm_bindgen]
pub fn crc32_wasm(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

#[wasm_bindgen]
pub struct PackIndexParser;

#[wasm_bindgen]
impl PackIndexParser {
    pub fn parse_index(data: &[u8], entry_count: u32) -> Result<Vec<PackIndexEntry>, JsValue> {
        let mut entries = Vec::with_capacity(entry_count as usize);
        let mut pos = 0usize;
        let len = data.len();

        for _ in 0..entry_count {
            if pos + 2 > len {
                return Err(JsValue::from_str("Unexpected end of index data (path length)"));
            }
            let path_len = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;

            if pos + path_len > len {
                return Err(JsValue::from_str("Unexpected end of index data (path)"));
            }
            let path = String::from_utf8_lossy(&data[pos..pos + path_len]).to_string();
            pos += path_len;

            if pos + 2 > len {
                return Err(JsValue::from_str("Unexpected end of index data (mime length)"));
            }
            let mime_len = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;

            if pos + mime_len > len {
                return Err(JsValue::from_str("Unexpected end of index data (mime)"));
            }
            let mime_type = String::from_utf8_lossy(&data[pos..pos + mime_len]).to_string();
            pos += mime_len;

            if pos + 8 > len {
                return Err(JsValue::from_str("Unexpected end of index data (offset)"));
            }
            let offset = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            if pos + 8 > len {
                return Err(JsValue::from_str("Unexpected end of index data (size)"));
            }
            let size = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            if pos + 8 > len {
                return Err(JsValue::from_str("Unexpected end of index data (compressed_size)"));
            }
            let compressed_size = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            if pos + 4 > len {
                return Err(JsValue::from_str("Unexpected end of index data (flags)"));
            }
            let flags = u32::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
            ]);
            pos += 4;

            let iv = if pos + 12 <= len {
                data[pos..pos + 12].to_vec()
            } else {
                vec![0u8; 12]
            };
            pos += 12;

            let raw_size = 2 + path_len + 2 + mime_len + 8 + 8 + 8 + 4 + 12;
            let aligned = ((raw_size + 7) / 8) * 8;
            let padding = aligned - raw_size;
            pos += padding;

            entries.push(PackIndexEntry {
                path,
                mime_type,
                offset,
                size,
                compressed_size,
                flags,
                iv,
            });
        }

        Ok(entries)
    }
}

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};

#[wasm_bindgen]
pub struct AesGcmCipher {
    cipher: Aes256Gcm,
}

#[wasm_bindgen]
impl AesGcmCipher {
    pub fn new(key: &[u8]) -> Result<AesGcmCipher, JsValue> {
        if key.len() != 32 {
            return Err(JsValue::from_str("Key must be 32 bytes (256 bits)"));
        }
        let key_array: [u8; 32] = key.try_into().map_err(|_| JsValue::from_str("Key conversion failed"))?;
        let cipher = Aes256Gcm::new_from_slice(&key_array)
            .map_err(|e| JsValue::from_str(&format!("Failed to create cipher: {:?}", e)))?;
        Ok(AesGcmCipher { cipher })
    }

    pub fn encrypt(&self, plaintext: &[u8], iv: &[u8]) -> Result<Vec<u8>, JsValue> {
        if iv.len() != 12 {
            return Err(JsValue::from_str("IV must be 12 bytes"));
        }
        let nonce = Nonce::from_slice(iv);
        self.cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| JsValue::from_str(&format!("Encryption failed: {:?}", e)))
    }

    pub fn decrypt(&self, ciphertext: &[u8], iv: &[u8]) -> Result<Vec<u8>, JsValue> {
        if iv.len() != 12 {
            return Err(JsValue::from_str("IV must be 12 bytes"));
        }
        let nonce = Nonce::from_slice(iv);
        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| JsValue::from_str(&format!("Decryption failed: {:?}", e)))
    }
}

#[wasm_bindgen]
pub fn generate_random_iv() -> Vec<u8> {
    let mut iv = vec![0u8; 12];
    for i in 0..12 {
        iv[i] = (js_sys::Math::random() * 256.0) as u8;
    }
    iv
}

#[wasm_bindgen]
pub fn compress_lz4(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    use lz4_flex::block::compress;
    Ok(compress(data))
}

#[wasm_bindgen]
pub fn decompress_lz4(data: &[u8], original_size: usize) -> Result<Vec<u8>, JsValue> {
    use lz4_flex::block::decompress;
    decompress(data, original_size)
        .map_err(|e| JsValue::from_str(&format!("LZ4 decompression failed: {:?}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_known_value() {
        let data = b"123456789";
        let hash = crc32fast::hash(data);
        assert_eq!(hash, 0xcbf43926);
    }

    #[test]
    fn aes_gcm_roundtrip() {
        let key = vec![0u8; 32];
        let iv = vec![0u8; 12];
        let plaintext = b"Hello, World!";

        let cipher = AesGcmCipher::new(&key).unwrap();
        let encrypted = cipher.encrypt(plaintext, &iv).unwrap();
        let decrypted = cipher.decrypt(&encrypted, &iv).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn parse_index_single_entry() {
        let mut data = vec![];
        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(b"test");
        data.extend_from_slice(&10u16.to_le_bytes());
        data.extend_from_slice(b"text/plain");
        data.extend_from_slice(&100u64.to_le_bytes());
        data.extend_from_slice(&50u64.to_le_bytes());
        data.extend_from_slice(&50u64.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&[0u8; 12]);

        let entries = PackIndexParser::parse_index(&data, 1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path(), "test");
        assert_eq!(entries[0].mime_type(), "text/plain");
        assert_eq!(entries[0].offset(), 100);
        assert_eq!(entries[0].size(), 50);
        assert_eq!(entries[0].compressed_size(), 50);
        assert_eq!(entries[0].flags(), 0);
    }
}
