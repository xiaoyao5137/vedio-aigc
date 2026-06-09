import { createServer } from 'vite'

const host = process.env.APP_HOST ?? '127.0.0.1'
const port = Number(process.env.APP_PORT ?? 5173)

const server = await createServer({
  server: {
    host,
    port,
    strictPort: true,
  },
})

await server.listen()
server.printUrls()

setInterval(() => {}, 60_000)
