import { useEffect, useId, useRef, useState } from 'react'

import { mountFlexPositionTracker } from '@/lib/flexPositionTracker.js'

type Theme = 'light' | 'dark'

const resolveTheme = (): Theme => {
  const stored = window.localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme())

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('theme', theme)
  }, [theme])

  return (
    <button
      className="theme-switch"
      type="button"
      role="switch"
      aria-label="Toggle light or dark theme"
      aria-checked={theme === 'dark'}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-knob" />
      </span>
      <span className="theme-switch-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  )
}

export function App() {
  const trackerRef = useRef<HTMLElement>(null)
  const advancedOptionsRef = useRef<HTMLDialogElement>(null)
  const advancedOptionsId = useId()
  const advancedOptionsTitleId = useId()
  const walletManagerId = useId()
  const walletManagerTitleId = useId()
  const walletMessageId = useId()
  const walletInputId = useId()
  const panelId = 'trove-statement-panel'
  const panelTitleId = 'trove-statement-title'
  const exportOptionsId = useId()
  const methodTitleId = useId()

  useEffect(() => {
    if (trackerRef.current) mountFlexPositionTracker(trackerRef.current)
  }, [])

  return (
    <main className="page-shell">
      <article className="tracker-page" data-flex-tracker ref={trackerRef}>
        <header className="tracker-header">
          <h1>Flex Position Tracker</h1>
          <div className="tracker-header-actions">
            <ThemeToggle />
            <button
              type="button"
              className="advanced-options-toggle"
              aria-label="Advanced options"
              title="Advanced options"
              aria-haspopup="dialog"
              aria-controls={advancedOptionsId}
              onClick={() => advancedOptionsRef.current?.showModal()}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M9.5 3h5l.6 3a7 7 0 0 1 1.6.9l2.9-1 2.5 4.2-2.3 2a7 7 0 0 1 0 1.8l2.3 2-2.5 4.2-2.9-1a7 7 0 0 1-1.6.9l-.6 3h-5l-.6-3a7 7 0 0 1-1.6-.9l-2.9 1-2.5-4.2 2.3-2a7 7 0 0 1 0-1.8l-2.3-2L4.4 5.9l2.9 1A7 7 0 0 1 8.9 6z"
                  transform="translate(0 -1)"
                />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </header>

        <section className="controls" aria-label="Tracker controls">
          <form data-wallet-form>
            <label htmlFor={walletInputId}>
              <span>Ethereum address</span>
            </label>
            <div className="wallet-input-control">
              <input
                id={walletInputId}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck="false"
                placeholder="0x…"
                aria-describedby={walletMessageId}
                data-wallet-input
              />
              <button type="submit">Add address</button>
            </div>
          </form>
          <button
            type="button"
            className="manage-wallets-toggle"
            data-wallet-manager-toggle
            aria-haspopup="dialog"
            aria-expanded="false"
            aria-controls={walletManagerId}
          >
            Manage addresses
          </button>
          <button type="button" data-refresh>
            Refresh now
          </button>
          <output
            className="wallet-manager-message"
            id={walletMessageId}
            aria-live="polite"
            data-wallet-message
          />
        </section>

        <dialog
          className="wallet-manager"
          id={walletManagerId}
          aria-labelledby={walletManagerTitleId}
          data-wallet-manager
        >
          <header>
            <div>
              <p className="eyebrow">Browser tracking list</p>
              <h2 id={walletManagerTitleId}>Manage addresses</h2>
            </div>
            <p>Select wallets to filter loaded Troves. Refresh now loads data for new addresses.</p>
          </header>
          <ul className="wallet-list" data-wallet-list aria-label="Wallets to show">
            <li className="is-empty">Loading addresses…</li>
          </ul>
          <output className="wallet-manager-message" aria-live="polite" data-wallet-message />
          <form method="dialog">
            <button type="submit">Done</button>
          </form>
        </dialog>

        <output className="tracker-status" aria-live="polite" data-status>
          Preparing live reads…
        </output>
        <dialog
          ref={advancedOptionsRef}
          id={advancedOptionsId}
          className="advanced-options"
          aria-labelledby={advancedOptionsTitleId}
        >
          <h2 id={advancedOptionsTitleId}>Advanced options</h2>
          <div className="projection-controls">
            <label>
              <span>Projection source</span>
              <select data-projection-source defaultValue="automatic">
                <option value="automatic">Automatic</option>
                <option value="estimated">Estimated APY</option>
                <option value="oracle">Oracle APY</option>
                <option value="pps7">7-day PPS APY</option>
                <option value="pps30">30-day PPS APY</option>
              </select>
            </label>
            <p>
              Automatic uses estimated APY, then oracle APY, 7-day PPS APY, and 30-day PPS APY. For
              ysyBOLD, the higher of oracle and 7-day PPS replaces estimated APY. Choose Refresh now
              to apply changes.
            </p>
          </div>
          <form method="dialog">
            <button type="submit">Done</button>
          </form>
        </dialog>
        <div data-summary />
        <div className="positions" data-positions aria-live="polite">
          <div className="position skeleton" aria-hidden="true">
            <div />
            <div />
            <div />
            <div />
          </div>
          <div className="position skeleton" aria-hidden="true">
            <div />
            <div />
            <div />
            <div />
          </div>
        </div>

        <div className="statement-layer" data-statement-layer hidden>
          <div className="statement-backdrop" data-statement-close aria-hidden="true" />
          <section
            className="statement-panel"
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={panelTitleId}
            data-statement-panel
          >
            <header className="statement-panel-header">
              <div>
                <p className="eyebrow" data-statement-kicker>
                  Trove statement
                </p>
                <h2 id={panelTitleId} data-statement-title>
                  Position
                </h2>
                <p className="position-state" data-statement-status />
              </div>
              <div className="statement-panel-actions">
                <div className="statement-export">
                  <button
                    type="button"
                    className="statement-export-toggle"
                    data-statement-export-toggle
                    aria-expanded="false"
                    aria-controls={exportOptionsId}
                  >
                    Export
                  </button>
                  <div
                    className="statement-export-options"
                    id={exportOptionsId}
                    data-statement-export-options
                    hidden
                  >
                    <button type="button" data-statement-export="html">
                      <span>HTML</span>
                      <small>Standalone report</small>
                    </button>
                    <button type="button" data-statement-export="pdf">
                      <span>PDF</span>
                      <small>Print or save as PDF</small>
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="statement-close"
                  data-statement-close
                  aria-label="Close Trove statement"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </header>
            <div className="statement-panel-content" data-statement-content />
          </section>
        </div>

        <section className="method" aria-labelledby={methodTitleId}>
          <header>
            <h2 id={methodTitleId}>Accounting Formulas</h2>
          </header>
          <div className="equations">
            <code>
              PPS value change = current collateral value + redeemed and closed collateral at event
              PPS + liquidated collateral at event PPS + collateral withdrawals at event PPS −
              collateral deposits at event PPS − opening collateral value
            </code>
            <code>
              accrued interest = remaining + redeemed + repaid + liquidated + written-off + closed
              debt − opening and additional principal − all one-time fees
            </code>
            <code>
              liquidation impact = liquidator repayment + debt written off − seized collateral at
              event PPS
            </code>
            <code>
              settlement-adjusted P&amp;L = Trove P&amp;L + settled funding value − nominal
              principal
            </code>
            <code>redemption impact = debt cancelled − redeemed collateral at event PPS</code>
            <code>
              Trove P&amp;L = PPS value change + redemption impact + liquidation impact − accrued
              interest − all one-time fees
            </code>
            <code>
              annual carry = collateral value × historical net APR − debt × current borrow APR
            </code>
          </div>
        </section>

        <footer className="source-footer">
          <p>Sources</p>
          <nav aria-label="Protocol and data sources">
            <a href="https://flexmeow.com/docs" target="_blank" rel="noreferrer">
              Flex docs
            </a>
            <a href="https://flexmeow.com/info" target="_blank" rel="noreferrer">
              Flex contracts
            </a>
            <a href="https://github.com/flexmeow" target="_blank" rel="noreferrer">
              Flex GitHub
            </a>
            <a href="https://kong.yearn.fi" target="_blank" rel="noreferrer">
              Kong
            </a>
            <a href="https://eth.blockscout.com" target="_blank" rel="noreferrer">
              Ethereum reads
            </a>
          </nav>
        </footer>
      </article>
    </main>
  )
}
