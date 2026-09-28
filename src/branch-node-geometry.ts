/** Keep the input at the shared row center; the false route leaves the bottom tip. */
export function branchOutputOffset(port?: 'true' | 'false') {
  return port === 'false' ? { x: 124, y: 154 } : { x: 248, y: 62 }
}
