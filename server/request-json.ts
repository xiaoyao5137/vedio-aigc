import type { IncomingMessage } from 'node:http'

/** Decode the complete request body at once so a UTF-8 code point split across
 * transport chunks is never replaced with U+FFFD. */
export function parseJsonChunks<T>(chunks: Uint8Array[]) {
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as T
}

export function readJson<T>(req: IncomingMessage) {
  return new Promise<T>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    })
    req.on('end', () => {
      try {
        resolve(parseJsonChunks<T>(chunks))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
