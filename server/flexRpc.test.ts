import { describe, expect, it, vi } from 'vitest'

import { handleFlexRpc, isAllowedFlexRpcRequest } from './flexRpc'

const validRequest = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'eth_blockNumber',
  params: [],
}

describe('Flex RPC boundary', () => {
  it('accepts only the read methods used by the tracker', () => {
    expect(isAllowedFlexRpcRequest(validRequest)).toBe(true)
    expect(
      isAllowedFlexRpcRequest({
        ...validRequest,
        method: 'eth_getTransactionByHash',
        params: ['0x123'],
      }),
    ).toBe(true)
    expect(isAllowedFlexRpcRequest({ ...validRequest, method: 'eth_sendTransaction' })).toBe(false)
  })

  it('falls back when the primary provider fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
        ),
    )
    const result = await handleFlexRpc(
      validRequest,
      'https://primary.test',
      'https://fallback.test',
    )
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body).result).toBe('0x1')
    vi.unstubAllGlobals()
  })
})

it('rejects arbitrary tracers and exposes only the bounded call tracer', () => {
  const hash = `0x${'a'.repeat(64)}`
  expect(
    isAllowedFlexRpcRequest({
      ...validRequest,
      method: 'debug_traceTransaction',
      params: [hash, { tracer: 'callTracer', timeout: '10s' }],
    }),
  ).toBe(true)
  expect(
    isAllowedFlexRpcRequest({
      ...validRequest,
      method: 'debug_traceTransaction',
      params: [hash, { tracer: 'arbitrary code' }],
    }),
  ).toBe(false)
  expect(
    isAllowedFlexRpcRequest({
      ...validRequest,
      method: 'debug_traceTransaction',
      params: ['../../anything', { tracer: 'callTracer', timeout: '10s' }],
    }),
  ).toBe(false)
})

it('falls back to complete explorer traces when RPC tracing is unsupported', async () => {
  const hash = `0x${'a'.repeat(64)}`
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -32601 } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -32601 } })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            traceAddress: [],
            type: 'call',
            action: { callType: 'call', from: 'sender', to: 'router', input: '0x' },
            result: { output: '0x' },
            subtraces: 1,
          },
          {
            traceAddress: [0],
            type: 'call',
            action: { callType: 'call', from: 'router', to: 'manager', input: '0x1234' },
            result: { output: '0x' },
            subtraces: 0,
          },
        ]),
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const response = await handleFlexRpc(
      {
        ...validRequest,
        method: 'debug_traceTransaction',
        params: [hash, { tracer: 'callTracer', timeout: '10s' }],
      },
      'https://primary.test',
      'https://fallback.test',
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).result.calls[0].to).toBe('manager')
    expect(fetchMock.mock.calls[2][0]).toBe(
      `https://eth.blockscout.com/api/v2/transactions/${hash}/raw-trace`,
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
