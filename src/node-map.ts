export type MapInput = { sourcePath: string; itemVar: string; maxItems?: number; concurrency?: number }

export class MapInputItemError extends Error {
  itemIndex: number
  sourcePath: string

  constructor(sourcePath: string, itemIndex: number, cause: unknown) {
    super(`MAP_ITEM_FAILED: ${sourcePath}[${itemIndex}]（第 ${itemIndex + 1} 项）: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'MapInputItemError'
    this.itemIndex = itemIndex
    this.sourcePath = sourcePath
  }
}

/** Mapping remains sequential unless explicitly configured. Original indices
 * identify item requests and output slots regardless of completion order. */
export async function mapNodeInputs(config: MapInput, context: Record<string, unknown>, execute: (context: Record<string, unknown>, index: number) => Promise<unknown>) {
  const values = config.sourcePath.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, context)
  const limit = config.maxItems ?? 24
  const concurrency = config.concurrency === undefined ? 1 : config.concurrency
  if (!Array.isArray(values) || !Number.isInteger(limit) || limit < 1 || limit > 100 || values.length > limit
    || !config.itemVar || ['__proto__', 'constructor', 'prototype'].includes(config.itemVar)
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('MAP_CONFIG_INVALID: 需配置数组来源、变量名、有效数量上限及 1–4 的整数并发数')
  }
  const sourceItems = [...values]
  const items: unknown[] = new Array(sourceItems.length)
  let nextIndex = 0
  let failure: MapInputItemError | undefined
  const worker = async () => {
    while (!failure && nextIndex < sourceItems.length) {
      const index = nextIndex++
      try {
        items[index] = await execute({ ...context, [config.itemVar]: sourceItems[index] }, index)
      } catch (error) {
        failure ??= new MapInputItemError(config.sourcePath, index, error)
      }
    }
  }
  // Each worker handles its own rejection. Waiting for all workers drains every
  // request already started while preventing new requests after the first failure.
  await Promise.all(Array.from({ length: Math.min(concurrency, sourceItems.length) }, worker))
  if (failure) throw failure
  return { items, count: items.length }
}
