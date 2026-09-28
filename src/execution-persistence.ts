export type PersistenceResult = { saved: true } | { saved: false; error: string }

export class ExecutionPersistenceError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecutionPersistenceError' }
}

/** Checkpoints must reach storage in call order. A failed write must not poison
 * later retries or allow an older, slower write to replace a newer result. */
export function createExecutionSaveQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(save: () => Promise<T>): Promise<T> => {
    const result = tail.then(save)
    tail = result.catch(() => undefined)
    return result
  }
}

export async function requireExecutionCheckpoint(save: () => Promise<PersistenceResult>): Promise<void> {
  const result = await save()
  if (!result.saved) throw new ExecutionPersistenceError(result.error)
}
