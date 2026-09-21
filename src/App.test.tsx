import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flexPositionTracker.js', () => ({ mountFlexPositionTracker: vi.fn() }))

import { App } from './App'

describe('App', () => {
  it('renders the tracker shell and wallet entry', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Flex Position Tracker' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Ethereum address' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeTruthy()
  })
})
