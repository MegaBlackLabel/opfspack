import { PackReader } from '../reader.js'
import type { PackWorkerAPI, PackEntryProxy } from '../types.js'

export interface ArrowIPCMetadata {
  schema: {
    fields: Array<{ name: string; type: string }>
  }
  recordCount: number
  records: Array<Record<string, unknown>>
}

export class PackWorker implements PackWorkerAPI {
  ipcChannel: string
  sharedBuffer: SharedArrayBuffer | ArrayBuffer
  private packReaders = new Map<string, PackReader>()
  private sabSupported: boolean

  constructor(channel: string, bufferSize: number) {
    this.ipcChannel = channel
    this.sabSupported =
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
    this.sharedBuffer = this.sabSupported
      ? new SharedArrayBuffer(bufferSize)
      : new ArrayBuffer(bufferSize)
  }

  loadPack(packId: string, buffer: ArrayBuffer): void {
    this.packReaders.set(packId, PackReader.fromBuffer(buffer))
  }

  isSharedArrayBufferSupported(): boolean {
    return this.sabSupported
  }

  private writeToBuffer(data: Uint8Array): Uint8Array {
    const view = new Uint8Array(this.sharedBuffer)
    view.set(data)
    return new Uint8Array(this.sharedBuffer, 0, data.byteLength)
  }

  async readEntry(packId: string, entryPath: string): Promise<PackEntryProxy> {
    const reader = this.packReaders.get(packId)
    if (!reader) {
      throw new Error(`Pack not found: ${packId}`)
    }

    const info = reader.getEntryInfo(entryPath)
    if (!info) {
      throw new Error(`Entry not found: ${entryPath}`)
    }

    const data = await reader.readEntry(entryPath)
    const bytes = new Uint8Array(data)

    if (bytes.byteLength <= this.sharedBuffer.byteLength) {
      const proxyData = this.writeToBuffer(bytes)
      const transfer: ArrayBuffer[] = []
      if (this.sharedBuffer instanceof ArrayBuffer) {
        transfer.push(this.sharedBuffer)
      }
      return {
        path: info.path,
        mimeType: info.mimeType,
        data: proxyData,
        transfer,
      }
    }

    return {
      path: info.path,
      mimeType: info.mimeType,
      data: bytes,
      transfer: [data],
    }
  }

  async readEntryRange(
    packId: string,
    entryPath: string,
    start: number,
    end: number,
  ): Promise<PackEntryProxy> {
    const reader = this.packReaders.get(packId)
    if (!reader) {
      throw new Error(`Pack not found: ${packId}`)
    }

    const info = reader.getEntryInfo(entryPath)
    if (!info) {
      throw new Error(`Entry not found: ${entryPath}`)
    }

    if (start < 0 || end > info.size || start >= end) {
      throw new Error('Invalid range')
    }

    const rangeData = await reader.readEntryRange(entryPath, start, end)
    const bytes = new Uint8Array(rangeData)

    if (bytes.byteLength <= this.sharedBuffer.byteLength) {
      const proxyData = this.writeToBuffer(bytes)
      const transfer: ArrayBuffer[] = []
      if (this.sharedBuffer instanceof ArrayBuffer) {
        transfer.push(this.sharedBuffer)
      }
      return {
        path: info.path,
        mimeType: info.mimeType,
        data: proxyData,
        transfer,
      }
    }

    return {
      path: info.path,
      mimeType: info.mimeType,
      data: bytes,
      transfer: [rangeData],
    }
  }

  async listEntries(packId: string): Promise<ArrowIPCMetadata> {
    const reader = this.packReaders.get(packId)
    if (!reader) {
      throw new Error(`Pack not found: ${packId}`)
    }

    const entries = reader.listEntries()
    return {
      schema: {
        fields: [
          { name: 'path', type: 'string' },
          { name: 'mimeType', type: 'string' },
          { name: 'size', type: 'int64' },
          { name: 'compressedSize', type: 'int64' },
          { name: 'flags', type: 'int32' },
        ],
      },
      recordCount: entries.length,
      records: entries.map((entry) => ({
        path: entry.path,
        mimeType: entry.mimeType,
        size: entry.size,
        compressedSize: entry.compressedSize,
        flags: entry.flags,
      })),
    }
  }
}
