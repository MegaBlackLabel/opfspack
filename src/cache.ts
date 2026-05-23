export interface CacheEntry {
  key: string
  data: ArrayBuffer
  size: number
}

export class LRUCache {
  private cache = new Map<string, CacheEntry>()
  private maxSize: number
  private currentSize = 0

  constructor(maxSizeBytes: number) {
    this.maxSize = maxSizeBytes
  }

  get(key: string): ArrayBuffer | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      this.cache.delete(key)
      this.cache.set(key, entry)
      return entry.data
    }
    return undefined
  }

  set(key: string, data: ArrayBuffer): void {
    const size = data.byteLength
    
    if (size > this.maxSize) {
      return
    }

    if (this.cache.has(key)) {
      const old = this.cache.get(key)!
      this.currentSize -= old.size
      this.cache.delete(key)
    }

    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        const first = this.cache.get(firstKey)!
        this.currentSize -= first.size
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, { key, data, size })
    this.currentSize += size
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
    this.currentSize = 0
  }

  get size(): number {
    return this.currentSize
  }

  get count(): number {
    return this.cache.size
  }
}
