interface TraceFrame {
  type: string
  from?: string
  to?: string
  input?: string
  output?: string
  error?: string
  calls: TraceFrame[]
}
interface FlatTrace {
  traceAddress: number[]
  type: string
  subtraces: number
  action: { callType?: string; from?: string; to?: string; input?: string }
  result?: { output?: string }
  error?: string
}

// Blockscout exposes Parity-style traces. Preserve parent errors and call order.
export function normalizeExplorerTrace(value: unknown): TraceFrame {
  if (!Array.isArray(value) || !value.length || value.length > 10000)
    throw new Error('Invalid trace')
  const frames = new Map<string, TraceFrame>()
  const entries = [...value] as FlatTrace[]
  entries.sort((a, b) => (a.traceAddress?.length ?? 0) - (b.traceAddress?.length ?? 0))
  for (const entry of entries) {
    const path = entry.traceAddress
    if (
      !Array.isArray(path) ||
      path.some((part) => !Number.isSafeInteger(part) || part < 0) ||
      !entry.action
    )
      throw new Error('Invalid trace address')
    const key = path.join('.')
    if (frames.has(key)) throw new Error('Duplicate trace address')
    const frame: TraceFrame = {
      type: (entry.action.callType ?? entry.type).toUpperCase(),
      from: entry.action.from,
      to: entry.action.to,
      input: entry.action.input,
      output: entry.result?.output,
      error: entry.error,
      calls: [],
    }
    frames.set(key, frame)
    if (path.length) {
      const parent = frames.get(path.slice(0, -1).join('.'))
      if (!parent) throw new Error('Missing trace parent')
      parent.calls[path[path.length - 1]] = frame
    }
  }
  for (const entry of entries) {
    const frame = frames.get(entry.traceAddress.join('.'))
    if (!frame) throw new Error('Missing trace frame')
    if (frame.calls.length !== entry.subtraces || Array.from(frame.calls).some((call) => !call))
      throw new Error('Incomplete call trace')
  }
  const root = frames.get('')
  if (!root) throw new Error('Missing trace root')
  return root
}
