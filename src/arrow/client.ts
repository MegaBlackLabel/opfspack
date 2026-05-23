import * as Comlink from 'comlink'
import type { PackEntryProxy } from '../types.js'
import type { PackWorker } from './worker.js'

export class PackWorkerClient {
  private api: Comlink.Remote<PackWorker>

  constructor(worker: Worker) {
    this.api = Comlink.wrap(worker)
  }

  get ipcChannel(): Promise<string> {
    return this.api.ipcChannel
  }

  async readEntryAsProxy(
    packId: string,
    entryPath: string,
  ): Promise<PackEntryProxy> {
    return this.api.readEntry(packId, entryPath)
  }
}
