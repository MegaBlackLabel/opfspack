import { PackBuilder } from './builder.js'
import { PackReader } from './reader.js'
import type { PackStorage } from './manager.js'

export interface FileSystem {
  listFiles(): Promise<Array<{ path: string; data: Uint8Array }>>
}

export interface MigrationProgress {
  currentBook: string
  totalBooks: number
  currentFile: number
  totalFiles: number
}

export interface MigrationOptions {
  onProgress?: (progress: MigrationProgress) => void
  filter?: (path: string) => boolean
}

export interface MigrationResult {
  packs: string[]
  errors: Array<{ bookId: string; error: Error }>
}

export async function migrateToPacks(
  fs: FileSystem,
  storage: PackStorage,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const files = await fs.listFiles()

  const filteredFiles = options.filter
    ? files.filter((f) => options.filter!(f.path))
    : files

  const filesByBook = new Map<string, Array<{ path: string; data: Uint8Array }>>()

  for (const file of filteredFiles) {
    const bookId = file.path.split('/')[0]
    if (!bookId) continue

    if (!filesByBook.has(bookId)) {
      filesByBook.set(bookId, [])
    }
    filesByBook.get(bookId)!.push(file)
  }

  const result: MigrationResult = {
    packs: [],
    errors: [],
  }

  const totalBooks = filesByBook.size

  for (const [bookId, bookFiles] of filesByBook) {
    const totalFiles = bookFiles.length

    try {
      const builder = new PackBuilder()

      for (let i = 0; i < bookFiles.length; i++) {
        const file = bookFiles[i]!

        if (options.onProgress) {
          options.onProgress({
            currentBook: bookId,
            totalBooks,
            currentFile: i + 1,
            totalFiles,
          })
        }

        const mimeType = guessMimeType(file.path)
        builder.addEntry(file.path, file.data, mimeType)
      }

      const pack = await builder.build()
      await storage.write(bookId, pack)
      result.packs.push(bookId)
    } catch (error) {
      result.errors.push({
        bookId,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  return result
}

export async function validatePack(packData: ArrayBuffer): Promise<boolean> {
  try {
    const reader = PackReader.fromBuffer(packData)
    try {
      void reader.metadata
      const entries = reader.listEntries()

      for (const entry of entries) {
        await reader.readEntry(entry.path)
      }

      return true
    } finally {
      reader.close()
    }
  } catch {
    return false
  }
}

function guessMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'pdf':
      return 'application/pdf'
    case 'txt':
      return 'text/plain'
    case 'json':
      return 'application/json'
    case 'html':
      return 'text/html'
    case 'css':
      return 'text/css'
    case 'js':
      return 'application/javascript'
    default:
      return 'application/octet-stream'
  }
}
