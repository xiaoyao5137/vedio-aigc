type AdvisoryLockClient = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>
  release: () => void
}

type AdvisoryLockPool = {
  connect: () => Promise<AdvisoryLockClient>
}

/**
 * Serializes one resumable model request across browser reconnects, Vite HMR
 * module instances and local server processes that share the same database.
 * The caller must check the persisted response again after acquiring the lock.
 */
export async function withModelRequestAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  identity: string | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  if (!identity?.trim()) return execute()
  const client = await pool.connect()
  let locked = false
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [identity])
    locked = true
    return await execute()
  } finally {
    if (locked) {
      try { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [identity]) }
      catch { /* Releasing the client also releases its session advisory locks. */ }
    }
    client.release()
  }
}
