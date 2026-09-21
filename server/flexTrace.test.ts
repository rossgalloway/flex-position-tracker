import { expect, it } from 'vitest'
import { normalizeExplorerTrace } from './flexTrace'

const root = {
  traceAddress: [],
  type: 'call',
  action: { callType: 'call' },
  result: { output: '0x' },
  subtraces: 2,
}
const child = (index: number) => ({
  traceAddress: [index],
  type: 'call',
  action: { callType: 'call', to: `child${index}` },
  result: { output: '0x' },
  subtraces: 0,
})
it('retains execution order and reverted subtrees', () => {
  const trace = normalizeExplorerTrace([root, child(1), { ...child(0), error: 'reverted' }])
  expect(trace.calls.map((call) => call.to)).toEqual(['child0', 'child1'])
  expect(trace.calls[0].error).toBe('reverted')
})
it('rejects truncated, orphaned and duplicate trace evidence', () => {
  expect(() => normalizeExplorerTrace([root, child(0)])).toThrow()
  expect(() => normalizeExplorerTrace([child(0)])).toThrow()
  expect(() => normalizeExplorerTrace([root, child(0), child(0)])).toThrow()
  expect(() => normalizeExplorerTrace([])).toThrow()
})
