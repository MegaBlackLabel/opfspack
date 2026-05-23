import { describe, it, expect } from 'vitest'
import {
  PackEntryInfo,
  PackMetadata,
  PackProgress,
  PackOptions,
  ReadOptions,
  EntryOptions,
  PackWorkerAPI,
  PackEntryProxy,
  PackError,
  PackVersionError,
  PackCorruptedError,
  PackNotFoundError,
} from '../index'

describe('PackEntryInfo', () => {
  it('should be usable as an interface', () => {
    const entry: PackEntryInfo = {
      path: 'test.txt',
      mimeType: 'text/plain',
      size: 1024,
      compressedSize: 512,
      flags: 0,
      offset: 0n,
    }
    expect(entry.path).toBe('test.txt')
    expect(entry.mimeType).toBe('text/plain')
    expect(entry.size).toBe(1024)
    expect(entry.compressedSize).toBe(512)
    expect(entry.flags).toBe(0)
    expect(entry.offset).toBe(0n)
  })
})

describe('PackMetadata', () => {
  it('should be usable as an interface', () => {
    const meta: PackMetadata = {
      version: 2,
      flags: 0,
      createdAt: new Date('2025-01-01'),
      entryCount: 42,
    }
      expect(meta.version).toBe(2)
    expect(meta.flags).toBe(0)
    expect(meta.createdAt).toEqual(new Date('2025-01-01'))
    expect(meta.entryCount).toBe(42)
  })
})

describe('PackProgress', () => {
  it('should allow valid progress objects', () => {
    const progress: PackProgress = {
      phase: 'packing',
      current: 5,
      total: 10,
      bytesProcessed: 1024,
      bytesTotal: 2048,
    }
    expect(progress.phase).toBe('packing')
    expect(progress.current).toBe(5)
    expect(progress.total).toBe(10)
    expect(progress.bytesProcessed).toBe(1024)
    expect(progress.bytesTotal).toBe(2048)
  })

  it('should allow all valid phases', () => {
    const phases: PackProgress['phase'][] = ['scanning', 'packing', 'indexing', 'finalizing']
    for (const phase of phases) {
      const p: PackProgress = { phase, current: 0, total: 1, bytesProcessed: 0, bytesTotal: 1 }
      expect(p.phase).toBe(phase)
    }
  })
})

describe('PackOptions', () => {
  it('should allow minimal options', () => {
    const opts: PackOptions = {}
    expect(opts).toEqual({})
  })

  it('should allow all options', () => {
    const opts: PackOptions = {
      compression: 'deflate',
      identityBinding: true,
    }
    expect(opts.compression).toBe('deflate')
    expect(opts.identityBinding).toBe(true)
  })

  it('should allow compression none', () => {
    const opts: PackOptions = { compression: 'none' }
    expect(opts.compression).toBe('none')
  })

  it('should have identityBinding as optional and default to false when not specified', () => {
    const opts: PackOptions = {}
    expect(opts.identityBinding).toBeUndefined()
  })
})

describe('ReadOptions', () => {
  it('should allow minimal options', () => {
    const opts: ReadOptions = {}
    expect(opts).toEqual({})
  })

  it('should allow decompress option', () => {
    const opts: ReadOptions = { decompress: true }
    expect(opts.decompress).toBe(true)
  })
})

describe('EntryOptions', () => {
  it('should allow valid options', () => {
    const opts: EntryOptions = {
      compress: true,
    }
    expect(opts.compress).toBe(true)
  })

  it('should allow empty options', () => {
    const opts: EntryOptions = {}
    expect(opts).toEqual({})
  })
})

describe('PackWorkerAPI', () => {
  it('should be usable as an interface', () => {
    const sab = new SharedArrayBuffer(1024)
    const api: PackWorkerAPI = {
      ipcChannel: 'test-channel',
      sharedBuffer: sab,
    }
    expect(api.ipcChannel).toBe('test-channel')
    expect(api.sharedBuffer).toBe(sab)
  })
})

describe('PackEntryProxy', () => {
  it('should be usable as an interface', () => {
    const proxy: PackEntryProxy = {
      path: 'test.txt',
      mimeType: 'text/plain',
      data: new Uint8Array([1, 2, 3]),
      transfer: [new ArrayBuffer(4)],
    }
    expect(proxy.path).toBe('test.txt')
    expect(proxy.mimeType).toBe('text/plain')
    expect(proxy.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(proxy.transfer).toHaveLength(1)
  })
})

describe('PackError hierarchy', () => {
  it('PackError should extend Error with correct name', () => {
    const err = new PackError('something went wrong')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PackError)
    expect(err.name).toBe('PackError')
    expect(err.message).toBe('something went wrong')
  })

  it('PackVersionError should extend PackError with correct name', () => {
    const err = new PackVersionError('unsupported version')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PackError)
    expect(err).toBeInstanceOf(PackVersionError)
    expect(err.name).toBe('PackVersionError')
    expect(err.message).toBe('unsupported version')
  })

  it('PackCorruptedError should extend PackError with correct name', () => {
    const err = new PackCorruptedError('checksum mismatch')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PackError)
    expect(err).toBeInstanceOf(PackCorruptedError)
    expect(err.name).toBe('PackCorruptedError')
    expect(err.message).toBe('checksum mismatch')
  })

  it('PackNotFoundError should extend PackError with correct name', () => {
    const err = new PackNotFoundError('pack not found')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PackError)
    expect(err).toBeInstanceOf(PackNotFoundError)
    expect(err.name).toBe('PackNotFoundError')
    expect(err.message).toBe('pack not found')
  })

  it('should preserve stack traces', () => {
    const err = new PackError('test')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('PackError')
  })
})
