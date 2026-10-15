export function verifySourceInCallTree<T>(
  version: string,
  root: string,
  verify: () => Promise<T> | T,
): Promise<T>
