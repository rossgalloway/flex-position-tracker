import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleFlexRpc } from '../server/flexRpc'

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('RPC request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    response.statusCode = 405
    response.end(JSON.stringify({ error: { code: -32600, message: 'POST required' } }))
    return
  }

  try {
    const result = await handleFlexRpc(await readJson(request), process.env.RPC_URL_1)
    response.statusCode = result.status
    response.end(result.body)
  } catch (error) {
    response.statusCode = 400
    response.end(
      JSON.stringify({
        error: { code: -32700, message: error instanceof Error ? error.message : 'Invalid JSON' },
      }),
    )
  }
}
