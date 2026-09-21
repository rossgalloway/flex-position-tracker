import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

const wallets = [1, 2, 3].map((n) => `0x${String(n).repeat(40)}`)
const word = (value: bigint | number | string) => BigInt(value).toString(16).padStart(64, '0')
const abi = (...values: (bigint | number | string)[]) => `0x${values.map(word).join('')}`
const manager = '0xadf4e0226d59aac20272023c04b4dcf5ade7fc6e'
const logs = [wallets[0], wallets[0], wallets[1]].map((wallet, index) => ({
  address: manager,
  blockNumber: '0x18a0000',
  logIndex: `0x${index.toString(16)}`,
  transactionHash: `0x${word(index + 1)}`,
  topics: [
    '0x48cc6255485654cd31337a688b4a1e06f8a768af7ec431040b7015bbb57d44b7',
    `0x${word(index + 1)}`,
    `0x${word(wallet)}`,
  ],
  data: abi(2000n * 10n ** 18n, 1000_000000, 0, 50000),
}))

const fixtureFetch = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.startsWith('https://kong.yearn.fi')) {
    return new Response(
      JSON.stringify({
        performance: {
          estimated: { apy: 0.4 },
          oracle: { netAPY: 0.08 },
          historical: { weeklyNet: 0.12, monthlyNet: 0.06 },
        },
      }),
    )
  }
  const { id, method, params } = JSON.parse(String(init?.body))
  let result: unknown
  switch (method) {
    case 'eth_blockNumber':
      result = '0x18b0000'
      break
    case 'eth_getBlockByNumber':
      result = { timestamp: params[0] === '0x18b0000' ? '0x65015180' : '0x65000000' }
      break
    case 'eth_getLogs':
      result =
        params[0].address.toLowerCase() !== manager
          ? []
          : logs.filter((log) => !params[0].topics[1] || log.topics[1] === params[0].topics[1])
      break
    case 'eth_call': {
      const data = params[0].data as string
      const selector = data.slice(0, 10)
      if (selector === '0x87553b7e') {
        const index = Number(BigInt(`0x${data.slice(10)}`)) - 1
        result = abi(1000_000000, 2000n * 10n ** 18n, 50000, 0, 0, 0, logs[index].topics[2], 1)
      } else if (selector === '0x0ff8afc1') result = abi(1000_000000)
      else if (selector === '0x86fc88d3') result = abi(4)
      else if (selector === '0x11f37ceb') result = abi(10n ** 24n)
      else throw new Error(`Unexpected selector ${selector}`)
      break
    }
    default:
      throw new Error(`Unexpected method ${method}`)
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
})

const troves = () => document.querySelectorAll('[data-position]')
const equity = () => screen.getByText('Open Equity').parentElement?.querySelector('dd')?.textContent

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('flex-position-tracker:wallets', JSON.stringify(wallets))
  fixtureFetch.mockClear()
  vi.stubGlobal('fetch', fixtureFetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(Storage.prototype.setItem).mockRestore?.()
})

describe('wallet filtering', () => {
  it.each([null, 'invalid json'])(
    'starts empty without usable local preferences: %s',
    async (saved) => {
      localStorage.clear()
      if (saved !== null) localStorage.setItem('flex-position-tracker:wallets', saved)
      render(<App />)
      await screen.findByText('No tracked addresses.')
      expect(troves()).toHaveLength(0)
      expect(fixtureFetch).not.toHaveBeenCalled()
    },
  )

  it('filters Troves and aggregate totals immediately without fetching, and restores cached wallets', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    expect(equity()).toBe('3,000.00 USDC')
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    const reads = fixtureFetch.mock.calls.length
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[0] }))
    expect(troves()).toHaveLength(1)
    expect(equity()).toBe('1,000.00 USDC')
    expect(screen.queryByRole('heading', { name: wallets[0] })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[1] }))
    expect(screen.getByText('No Troves found.')).toBeTruthy()
    expect(screen.queryByText('Open Equity')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[2] }))
    expect(screen.getByText('No wallets selected.')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'All tracked wallets' }))
    expect(troves()).toHaveLength(3)
    expect(equity()).toBe('3,000.00 USDC')
    expect(fixtureFetch).toHaveBeenCalledTimes(reads)
  })

  it('removes visible Troves immediately and distinguishes new unloaded wallets from empty wallets', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    const reads = fixtureFetch.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: `Remove ${wallets[0]}` }))
    await waitFor(() => expect(troves()).toHaveLength(1))
    expect(equity()).toBe('1,000.00 USDC')
    fireEvent.click(screen.getByRole('checkbox', { name: 'All tracked wallets' }))
    const newWallet = `0x${'5'.repeat(40)}`
    fireEvent.change(screen.getByRole('textbox', { name: 'Ethereum address' }), {
      target: { value: newWallet },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }))
    await waitFor(() => expect(screen.getByText('Selected wallets need a refresh.')).toBeTruthy())
    expect(screen.queryByText('No Troves found.')).toBeNull()
    expect(fixtureFetch).toHaveBeenCalledTimes(reads)
  })

  it('applies the current selection when an in-flight refresh finishes and keeps unselected wallets loaded', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = fixtureFetch.getMockImplementation()
    if (!original) throw new Error('Missing fetch fixture')
    fixtureFetch.mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    await screen.findByRole('checkbox', { name: wallets[0] })
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[0] }))
    release()
    await waitFor(() => expect(troves()).toHaveLength(1))
    const reads = fixtureFetch.mock.calls.length
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[0] }))
    expect(troves()).toHaveLength(3)
    expect(fixtureFetch).toHaveBeenCalledTimes(reads)
  })

  it('uses the ysyBOLD estimate in automatic and estimated modes without a separate override option', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    const sources = document.querySelectorAll('template[data-position-statement]')
    expect((sources[0] as HTMLTemplateElement).content.textContent).toContain('Estimated APY')
    expect((sources[0] as HTMLTemplateElement).content.textContent).toContain('12.00%')
    expect(
      fixtureFetch.mock.calls.filter(([url]) => url.startsWith('https://kong.yearn.fi')),
    ).toHaveLength(1)
    const selector = document.querySelector('[data-projection-source]') as HTMLSelectElement
    expect(selector.value).toBe('automatic')
    expect(Array.from(selector.options).map((option) => option.value)).toEqual([
      'automatic',
      'estimated',
      'oracle',
      'pps7',
      'pps30',
    ])
    const reads = fixtureFetch.mock.calls.length
    fireEvent.change(selector, { target: { value: 'estimated' } })
    expect(fixtureFetch).toHaveBeenCalledTimes(reads)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    await waitFor(() => {
      const content = (
        document.querySelector('template[data-position-statement]') as HTMLTemplateElement
      ).content.textContent
      expect(content).toContain('12.00%')
      expect(content).not.toContain('40.00%')
      expect(content).toContain('Estimated APY')
    })
    expect(equity()).toBe('3,000.00 USDC')
  })

  it('keeps position accounting available when the requested projection source is missing', async () => {
    const original = fixtureFetch.getMockImplementation()
    if (!original) throw new Error('Missing fetch fixture')
    fixtureFetch.mockImplementation(async (url, init) =>
      url.startsWith('https://kong.yearn.fi')
        ? new Response('{}', { status: 503 })
        : original(url, init),
    )
    try {
      render(<App />)
      await waitFor(() => expect(troves()).toHaveLength(3))
      expect(equity()).toBe('3,000.00 USDC')
      const content = (
        document.querySelector('template[data-position-statement]') as HTMLTemplateElement
      ).content.textContent
      expect(content).toContain('Projected equity APRUnavailable')
      expect(content).toContain('Kong projection data could not be loaded')
      expect(screen.queryByText('Live reads are unavailable.')).toBeNull()
    } finally {
      fixtureFetch.mockImplementation(original)
    }
  })

  it('remembers added wallets and the selected subset across reloads of a legacy wallet list', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[0] }))
    const added = `0x${'5'.repeat(40)}`
    fireEvent.change(screen.getByRole('textbox', { name: 'Ethereum address' }), {
      target: { value: added },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }))
    await screen.findByRole('checkbox', { name: added })
    cleanup()
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    expect(screen.getByRole('checkbox', { name: wallets[0] })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: wallets[1] })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: added })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: `Remove ${wallets[1]}` }))
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: wallets[1] })).toBeNull())
    cleanup()
    render(<App />)
    await screen.findByText('No Troves found.')
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    expect(screen.queryByRole('checkbox', { name: wallets[1] })).toBeNull()
    expect(screen.getByRole('checkbox', { name: added })).toBeChecked()
  })

  it('remembers an explicitly empty selection without issuing reads after reload', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'All tracked wallets' }))
    cleanup()
    fixtureFetch.mockClear()
    render(<App />)
    await screen.findByText('No wallets selected.')
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(4)
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(fixtureFetch).not.toHaveBeenCalled()
  })

  it('keeps the prior list and selection when local storage cannot be written', async () => {
    render(<App />)
    await waitFor(() => expect(troves()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Manage addresses' }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full')
    })
    fireEvent.click(screen.getByRole('checkbox', { name: wallets[0] }))
    expect(screen.getByRole('checkbox', { name: wallets[0] })).toBeChecked()
    expect(troves()).toHaveLength(3)
    expect(screen.getByText(/Could not save wallet selection/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `Remove ${wallets[0]}` }))
    await screen.findByText('Storage full')
    expect(screen.getByRole('checkbox', { name: wallets[0] })).toBeChecked()
    expect(troves()).toHaveLength(3)
  })

  it.each([false, true])(
    'separates active P&L from lifetime P&L (all redeemed: %s)',
    async (allRedeemed) => {
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const response = await fixtureFetch(url, init)
        if (!init?.body) return response
        const { method, params } = JSON.parse(String(init.body))
        if (method !== 'eth_call') return response
        const payload = await response.json()
        if (params[0].data.startsWith('0x87553b7e')) {
          const id = Number(BigInt(`0x${params[0].data.slice(10)}`))
          if (allRedeemed || id === 3) payload.result = `${payload.result.slice(0, -64)}${word(2)}`
        }
        if (params[0].data === '0x11f37ceb' && params[1] === '0x18b0000') {
          payload.result = abi(11n * 10n ** 23n)
        }
        return new Response(JSON.stringify(payload))
      })
      render(<App />)
      await waitFor(() => expect(troves()).toHaveLength(3))
      const metric = (label: string) =>
        screen.getByText(label).parentElement?.querySelector('dd')?.textContent
      expect(metric('Active P&L')).toBe(allRedeemed ? 'None' : '+400.00 USDC')
      expect(metric('Lifetime P&L')).toBe('+600.00 USDC')
      expect(document.querySelectorAll('.aggregate-headlines > div')).toHaveLength(3)
      expect(metric('Settlement-adjusted P&L')).toBe('Unavailable')
      expect(metric('Final funding shortfall')).toBe('Unavailable')
    },
  )
})
