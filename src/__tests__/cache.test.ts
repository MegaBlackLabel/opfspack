import { describe, it, expect } from 'vitest'
import { LRUCache } from '../cache'

describe('LRUCache', () => {
  it('should store and retrieve entries', () => {
    const cache = new LRUCache(1000)
    const data = new ArrayBuffer(100)
    
    cache.set('key1', data)
    expect(cache.has('key1')).toBe(true)
    expect(cache.get('key1')).toBe(data)
  })

  it('should evict oldest entries when full', () => {
    const cache = new LRUCache(200)
    
    cache.set('key1', new ArrayBuffer(100))
    cache.set('key2', new ArrayBuffer(100))
    cache.set('key3', new ArrayBuffer(100))
    
    expect(cache.has('key1')).toBe(false)
    expect(cache.has('key2')).toBe(true)
    expect(cache.has('key3')).toBe(true)
  })

  it('should update access order on get', () => {
    const cache = new LRUCache(200)
    
    cache.set('key1', new ArrayBuffer(100))
    cache.set('key2', new ArrayBuffer(100))
    
    cache.get('key1')
    
    cache.set('key3', new ArrayBuffer(100))
    
    expect(cache.has('key1')).toBe(true)
    expect(cache.has('key2')).toBe(false)
    expect(cache.has('key3')).toBe(true)
  })

  it('should not store entries larger than max size', () => {
    const cache = new LRUCache(100)
    
    cache.set('key1', new ArrayBuffer(200))
    
    expect(cache.has('key1')).toBe(false)
  })

  it('should track size correctly', () => {
    const cache = new LRUCache(1000)
    
    cache.set('key1', new ArrayBuffer(300))
    cache.set('key2', new ArrayBuffer(400))
    
    expect(cache.size).toBe(700)
    expect(cache.count).toBe(2)
  })

  it('should clear all entries', () => {
    const cache = new LRUCache(1000)
    
    cache.set('key1', new ArrayBuffer(100))
    cache.set('key2', new ArrayBuffer(100))
    cache.clear()
    
    expect(cache.count).toBe(0)
    expect(cache.size).toBe(0)
  })
})
