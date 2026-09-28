import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('the persistent app server disables Vite reloads during long executions', async () => {
  const source = await readFile(new URL('../scripts/dev-server.mjs', import.meta.url), 'utf8')

  assert.match(source, /hmr:\s*false/)
})
