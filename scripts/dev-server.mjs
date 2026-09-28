import { createServer } from 'vite'

const host = process.env.APP_HOST ?? '127.0.0.1'
const port = Number(process.env.APP_PORT ?? 5173)

const server = await createServer({
  server: {
    host,
    port,
    strictPort: true,
    // This process hosts long-running workflow executions. Source edits must not
    // make Vite reload an active browser tab; developers can still use `npm run dev`.
    hmr: false,
  },
})

await server.listen()
server.printUrls()

setInterval(() => {}, 60_000)
