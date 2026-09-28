import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Serve newly generated audio immediately, without Vite's public-file watcher cache. */
export async function serveGeneratedAudio(req: IncomingMessage, res: ServerResponse, next: () => void, root = process.cwd()) {
  const filename = (req.url ?? '').split('?')[0]
  if (!/^\/tts-[\da-f-]+\.wav$/.test(filename)) return next()
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return }
  const file = path.join(root, 'public/generated', filename)
  let size: number
  try { size = (await stat(file)).size } catch { res.statusCode = 404; res.end('Audio not found'); return }
  let start = 0, end = size - 1
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, size - Number(match[2]))
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
    } else start = size
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.end(); return
    }
    res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', end - start + 1); res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file, { start, end })
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res)
}
