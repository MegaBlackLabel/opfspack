import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)

async function getModuleOptions() {
  if (isNode) {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const wasmPath = fileURLToPath(
      import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')
    )
    return { wasmBinary: readFileSync(wasmPath) }
  }
  return {}
}

function normalizeParam(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  return value
}

export async function createPackIndexDB() {
  const options = await getModuleOptions()
  const sqlite3Instance = await sqlite3InitModule(options as any)

  const connection = new sqlite3Instance.oo1.DB(':memory:')
  
  let queryQueue: Promise<unknown> = Promise.resolve()
  
  function enqueueQuery<T>(fn: () => Promise<T>): Promise<T> {
    const task = queryQueue.then(fn, fn)
    queryQueue = task.catch(() => {})
    return task
  }

  const db = drizzle(async (query, params, method) => {
    if (!connection) {
      throw new Error('SQLite is not initialised')
    }

    const normalizedParams = params.map(normalizeParam) as (
      | number
      | string
      | Uint8Array
      | bigint
      | null
    )[]

    return enqueueQuery(async () => {
      if (method === 'run') {
        const stmt = connection.prepare(query)
        try {
          if (normalizedParams.length > 0) {
            stmt.bind(normalizedParams)
          }
          stmt.step()
        } finally {
          stmt.finalize()
        }
        return { rows: [] }
      }

      const rows: Record<string, unknown>[] = []
      const stmt = connection.prepare(query)
      try {
        if (normalizedParams.length > 0) {
          stmt.bind(normalizedParams)
        }

        const colNames = stmt.getColumnNames()

        while (stmt.step()) {
          const row: Record<string, unknown> = {}
          colNames.forEach((col: string, i: number) => {
            const value = stmt.get(i)
            row[col] = value
            Object.defineProperty(row, i, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            })
          })
          rows.push(row)
        }
      } finally {
        stmt.finalize()
      }

      if (method === 'get') {
        return { rows: rows[0] ?? null } as { rows: any }
      }

      return { rows: rows } as { rows: any[] }
    })
  })

  return {
    db,
    async close() {
      if (connection) {
        connection.close()
      }
    },
  }
}
