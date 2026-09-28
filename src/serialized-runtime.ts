export type SerializableRuntimeFunction = { name: string; toString(): string }
type Binding = { dependency: SerializableRuntimeFunction; expression?: string }

/** Bind the actual names retained by the current build, never assumed source
 * names. All callers supply top-level function declarations from the same
 * bundle; their declaration names and lexical references are transformed
 * together. Dependencies with their own imports must supply a bound expression.
 * No variable-name rewriting or globally shared VM declarations are required. */
export function serializeRuntimeFunction(consumer: { toString(): string }, bindings: Binding[] = []): string {
  if (!bindings.length) return `(${consumer.toString()})`
  const names = bindings.map(binding => binding.dependency.name)
  if (names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name)) || new Set(names).size !== names.length) {
    throw Error('WORKFLOW_RUNTIME_BINDING_INVALID: 序列化依赖须有唯一可绑定的函数声明名')
  }
  return `((${names.join(',')})=>(${consumer.toString()}))(${bindings.map(binding => binding.expression ?? `(${binding.dependency.toString()})`).join(',')})`
}
