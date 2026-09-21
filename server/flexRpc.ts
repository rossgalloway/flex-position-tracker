import { normalizeExplorerTrace } from './flexTrace'

const DEFAULT_FALLBACK_RPC = 'https://eth.blockscout.com/api/eth-rpc'
const RPC_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_getBlockByNumber',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'debug_traceTransaction',
])

export interface JsonRpcPayload {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params: unknown[]
}

export interface FlexRpcResult {
  body: string
  status: number
}

export const isAllowedFlexRpcRequest = (payload: unknown): payload is JsonRpcPayload => {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return false
  const candidate = payload as Partial<JsonRpcPayload>
  if (candidate.method === 'debug_traceTransaction') {
    const params = candidate.params
    if (
      !Array.isArray(params) ||
      params.length !== 2 ||
      typeof params[0] !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(params[0])
    )
      return false
    if (JSON.stringify(params[1]) !== JSON.stringify({ tracer: 'callTracer', timeout: '10s' }))
      return false
  }
  return (
    candidate.jsonrpc === '2.0' &&
    (typeof candidate.id === 'number' || typeof candidate.id === 'string') &&
    typeof candidate.method === 'string' &&
    RPC_METHODS.has(candidate.method) &&
    Array.isArray(candidate.params)
  )
}

export async function handleFlexRpc(
  payload: unknown,
  primaryRpcUrl?: string,
  fallbackRpcUrl = DEFAULT_FALLBACK_RPC,
): Promise<FlexRpcResult> {
  if (!isAllowedFlexRpcRequest(payload)) {
    return {
      status: 400,
      body: JSON.stringify({ error: { code: -32600, message: 'Unsupported Flex RPC request' } }),
    }
  }

  const upstreams = [primaryRpcUrl, fallbackRpcUrl]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
  const failures: string[] = []
  const body = JSON.stringify(payload)

  for (const [index, upstream] of upstreams.entries()) {
    try {
      const response = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      })
      const responseBody = await response.text()
      if (!response.ok) {
        failures.push(`${index === 0 ? 'primary' : 'fallback'} returned ${response.status}`)
        continue
      }
      if (payload.method === 'debug_traceTransaction') {
        const decoded = JSON.parse(responseBody)
        if (decoded.error || !decoded.result) {
          failures.push('RPC trace unavailable')
          continue
        }
      }
      return { status: 200, body: responseBody }
    } catch {
      failures.push(`${index === 0 ? 'primary' : 'fallback'} request failed`)
    }
  }

  if (payload.method === 'debug_traceTransaction') {
    try {
      const response = await fetch(
        `https://eth.blockscout.com/api/v2/transactions/${payload.params[0]}/raw-trace`,
        {
          signal: AbortSignal.timeout(15_000),
        },
      )
      if (!response.ok) throw new Error('Explorer trace unavailable')
      const result = normalizeExplorerTrace(await response.json())
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) }
    } catch {
      failures.push('Explorer trace unavailable or incomplete')
    }
  }

  return {
    status: 502,
    body: JSON.stringify({
      error: {
        code: -32098,
        message: `Ethereum RPC providers unavailable (${failures.join('; ')})`,
      },
    }),
  }
}
