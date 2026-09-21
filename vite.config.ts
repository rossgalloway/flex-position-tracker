import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

import { handleFlexRpc } from './server/flexRpc'

const parseAllowedHosts = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sendJson = (response: ServerResponse, status: number, body: string) => {
  response.statusCode = status
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(body)
}

const flexRpcPlugin = (primaryRpcUrl?: string): Plugin => {
  const middleware =
    () => async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
      if (request.url !== '/api/flex-rpc') return next()
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        sendJson(
          response,
          405,
          JSON.stringify({ error: { code: -32600, message: 'POST required' } }),
        )
        return
      }
      try {
        const result = await handleFlexRpc(await readJson(request), primaryRpcUrl)
        sendJson(response, result.status, result.body)
      } catch (error) {
        sendJson(
          response,
          400,
          JSON.stringify({
            error: {
              code: -32700,
              message: error instanceof Error ? error.message : 'Invalid JSON',
            },
          }),
        )
      }
    }

  return {
    name: 'flex-rpc',
    configureServer(server) {
      server.middlewares.use(middleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware())
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHosts = [
    'localhost',
    '127.0.0.1',
    ...parseAllowedHosts(env.LOCAL_VITE_ALLOWED_HOSTS),
  ]
  return {
    plugins: [react(), flexRpcPlugin(env.RPC_URL_1)],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: { allowedHosts },
    preview: { allowedHosts },
  }
})
