import type { PackStorage } from '../manager.js'
import { PackNotFoundError } from '../errors.js'

export class OPFSPackStorage implements PackStorage {
  private rootDir: FileSystemDirectoryHandle | null = null

  private async getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootDir) {
      this.rootDir = await navigator.storage.getDirectory()
    }
    return this.rootDir
  }

  async write(packId: string, data: ArrayBuffer): Promise<void> {
    const dir = await this.getRootDir()
    const fileHandle = await dir.getFileHandle(packId, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async read(packId: string): Promise<ArrayBuffer> {
    try {
      const dir = await this.getRootDir()
      const fileHandle = await dir.getFileHandle(packId)
      const file = await fileHandle.getFile()
      return await file.arrayBuffer()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new PackNotFoundError(`Pack not found: ${packId}`)
      }
      throw error
    }
  }

  async delete(packId: string): Promise<void> {
    try {
      const dir = await this.getRootDir()
      await dir.removeEntry(packId)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new PackNotFoundError(`Pack not found: ${packId}`)
      }
      throw error
    }
  }

  async list(): Promise<string[]> {
    const dir = await this.getRootDir()
    const entries: string[] = []
    for await (const name of dir.keys()) {
      entries.push(name)
    }
    return entries
  }

  async exists(packId: string): Promise<boolean> {
    try {
      const dir = await this.getRootDir()
      await dir.getFileHandle(packId)
      return true
    } catch {
      return false
    }
  }
}
