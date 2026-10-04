/**
 * The browser UI.
 *
 * A single screen, in the order the brief describes: refresh the community from chain, ask in
 * plain language, get real people back with a reason for each, or an honest nobody-fits.
 *
 * Two design rules carried over from the problem statement:
 *
 *   - **No wallet is required.** ENS reads are `eth_call`s. `Connect wallet` is a small
 *     optional control in the header; nothing in the ask flow depends on it.
 *   - **Claims are inspectable.** The index shows where each field came from, and the exact
 *     messages sent to the model are one click away. So "the bio never reaches the
 *     instructions" is something a reviewer can see rather than take on trust.
 */

import React from 'react'
import { createRoot } from 'react-dom/client'

import './styles.css'
import {
  connectWallet,
  getInjectedProvider,
  hasInjectedProvider,
  shortenAddress,
  subscribeToWallet,
  switchToSepolia,
  WalletError,
  type WalletConnection,
} from './wallet'

// ---------------------------------------------------------------------------
// API types (mirrors the server's response shapes)
// ---------------------------------------------------------------------------

type RosterSource = 'ens-record' | 'configured' | 'simulated' | 'none'
type IndexStatus = 'empty' | 'loading' | 'ready' | 'error'
type RecordStatus = 'read' | 'unset' | 'failed'
type Availability = 'open' | 'limited' | 'unavailable'

interface ProfileWarning {
  field: string
  code: string
  detail: string
}

interface IndexedProfile {
  ensName: string
  address: string | null
  fields: {
    displayName: string | null
    role: string | null
    skills: string[]
    availability: Availability | null
    bio: string | null
  }
  recordStatus: Record<string, RecordStatus>
  warnings: ProfileWarning[]
  suspicious: boolean
  source: 'ens' | 'simulated'
}

interface CommunityState {
  status: IndexStatus
  refreshedAt: string | null
  root: string
  rosterSource: RosterSource
  rosterStatus: RecordStatus
  rosterError: string | null
  rosterRecordKey: string
  attemptedNames: string[]
  rejectedNames: Array<{ rawName: string; reason: string }>
  emptyProfiles: string[]
  failedProfiles: string[]
  partial: boolean
  notices: string[]
  error: string | null
  durationMs: number | null
  memberCount: number
  simulated: boolean
  profiles: IndexedProfile[]
}

interface Health {
  ok: boolean
  chain: string
  chainId: number
  config: {
    providerHost: string
    model: string
    timeoutMs: number
    hasApiKey: boolean
    rpcHost: string
    communityRoot: string
    topK: number
    minCandidateScore: number
    maxMembers: number
    allowSimulatedIndex: boolean
  }
  index: { status: IndexStatus; memberCount: number; rosterSource: RosterSource }
  notice: string
}

interface ExampleCase {
  id: string
  question: string
  expect: 'matches' | 'no-match'
  mustInclude: string[]
  mayInclude: string[]
  mustNotInclude: string[]
  why: string
}

interface CandidateSummary {
  ensName: string
  displayLabel: string
  score: number
  matchedTerms: string[]
  availability: string | null
}

interface MatchedPerson {
  ensName: string
  displayLabel: string
  reason: string
  evidence: string
  matchedTerms: string[]
  source: 'ens' | 'simulated'
  suspicious: boolean
  availability: Availability | null
  retrievalScore: number
}

interface FindResult {
  question: string
  noMatch: boolean
  headline: string
  noMatchReason: string | null
  matches: MatchedPerson[]
  rejected: Array<{ rawName: string; code: string; detail: string }>
  unavailableNearMisses: CandidateSummary[]
  retrieval: {
    considered: number
    aboveThreshold: number
    topK: number
    minScore: number
    candidatesSent: number
    candidates: CandidateSummary[]
    indexRefreshedAt: string | null
    indexSource: RosterSource
  }
  model: {
    used: boolean
    skippedReason: string | null
    model: string | null
    providerHost: string | null
    durationMs: number | null
    attempts: number | null
    messages: Array<{ role: string; content: string }> | null
    rawOutput: string | null
  }
}

interface ApiError {
  error: { code: string; message: string }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await response.json().catch(() => null)) as ApiError | T | null

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? (body as ApiError).error.message
        : `Request failed with HTTP ${response.status}.`
    throw new Error(message)
  }
  return body as T
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
}) {
  return <span className={`badge${tone === 'neutral' ? '' : ` ${tone}`}`}>{children}</span>
}

function AvailabilityPill({ value }: { value: Availability | null }) {
  if (value === null) return <Badge tone="warn">availability unknown</Badge>
  const tone = value === 'open' ? 'ok' : value === 'limited' ? 'warn' : 'danger'
  return <Badge tone={tone}>{value}</Badge>
}

function formatTime(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function Note({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error'
  children: React.ReactNode
}) {
  return <div className={`note ${tone}`}>{children}</div>
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [health, setHealth] = React.useState<Health | null>(null)
  const [healthError, setHealthError] = React.useState<string | null>(null)
  const [index, setIndex] = React.useState<CommunityState | null>(null)
  const [examples, setExamples] = React.useState<ExampleCase[]>([])
  const [refreshError, setRefreshError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const [question, setQuestion] = React.useState('')
  const [asking, setAsking] = React.useState(false)
  const [askError, setAskError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<FindResult | null>(null)

  const [wallet, setWallet] = React.useState<WalletConnection | null>(null)
  const [walletError, setWalletError] = React.useState<string | null>(null)
  const [walletBusy, setWalletBusy] = React.useState(false)

  const walletAvailable = React.useMemo(() => hasInjectedProvider(), [])

  // --- initial load ---------------------------------------------------------
  React.useEffect(() => {
    void (async () => {
      try {
        setHealth(await api<Health>('/api/health'))
      } catch (error) {
        setHealthError(error instanceof Error ? error.message : String(error))
      }
      try {
        setIndex(await api<CommunityState>('/api/community'))
        // First load: the server has not read the chain yet, so trigger one refresh.
        void refreshCommunity(true)
      } catch (error) {
        setRefreshError(error instanceof Error ? error.message : String(error))
      }
      try {
        const payload = await api<{ cases: ExampleCase[] }>('/api/examples')
        setExamples(payload.cases)
      } catch {
        setExamples([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- wallet event subscriptions -------------------------------------------
  React.useEffect(() => {
    const provider = getInjectedProvider()
    if (!provider) return
    return subscribeToWallet(provider, {
      onAccountsChanged: (accounts) => {
        if (accounts.length === 0) setWallet(null)
      },
      onChainChanged: () => {
        void reconnect(provider)
      },
      onDisconnected: () => setWallet(null),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reconnect = async (provider = getInjectedProvider()) => {
    if (!provider) return
    try {
      const connection = await connectWallet(provider)
      setWallet(connection)
      setWalletError(connection.networkError)
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : String(error))
    }
  }

  // --- actions ---------------------------------------------------------------
  const refreshCommunity = async (silent = false) => {
    if (!silent) setRefreshing(true)
    setRefreshError(null)
    try {
      setIndex(await api<CommunityState>('/api/community/refresh', { method: 'POST' }))
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    if (question.trim().length < 3) return
    setAsking(true)
    setAskError(null)
    setResult(null)
    try {
      setResult(
        await api<FindResult>('/api/find', {
          method: 'POST',
          body: JSON.stringify({ question: question.trim() }),
        }),
      )
    } catch (error) {
      setAskError(error instanceof Error ? error.message : String(error))
    } finally {
      setAsking(false)
    }
  }

  const disconnect = () => {
    setWallet(null)
    setWalletError(null)
  }

  // --- derived ---------------------------------------------------------------
  const statusLabel = (() => {
    if (refreshing) return 'refreshing from Sepolia…'
    switch (index?.status) {
      case 'ready':
        return `${index.memberCount} member${index.memberCount === 1 ? '' : 's'} indexed`
      case 'loading':
        return 'loading…'
      case 'error':
        return 'index error'
      default:
        return 'not loaded yet'
    }
  })()

  const rosterLabel = (() => {
    switch (index?.rosterSource) {
      case 'ens-record':
        return 'roster read from the root ENS record'
      case 'configured':
        return 'roster from .env (profiles still read live)'
      case 'simulated':
        return 'SIMULATED roster - not chain data'
      default:
        return 'no roster'
    }
  })()

  return (
    <div className="wrap">
      {/* ----------------------------------------------------------- header */}
      <header className="masthead">
        <div>
          <h1>Community People Finder</h1>
          <p>
            Ask the community in plain language. Get back real members, read live from their
            ENS text records on Sepolia, with a reason for each — and an honest{' '}
            <em>nobody fits</em> when that is the truth.
          </p>
        </div>

        <div className="header-side">
          <div className="badges">
            <Badge tone="accent">Sepolia · chain 11155111</Badge>
            {health ? (
              <Badge tone="warn">
                top-k {health.config.topK} · timeout {health.config.timeoutMs} ms
              </Badge>
            ) : null}
            <Badge tone={index?.simulated ? 'danger' : 'neutral'}>
              {wallet
                ? `${shortenAddress(wallet.address)} · ${wallet.networkLabel}`
                : walletAvailable
                  ? 'wallet not connected'
                  : 'no wallet detected'}
            </Badge>
          </div>

          <div className="row wallet-row">
            {wallet ? (
              <>
                <button className="secondary" onClick={disconnect}>
                  Disconnect
                </button>
                {!wallet.onSepolia ? (
                  <button
                    onClick={() => {
                      const provider = getInjectedProvider()
                      if (!provider) return
                      void switchToSepolia(provider)
                        .then(() => reconnect(provider))
                        .catch((error: unknown) =>
                          setWalletError(
                            error instanceof WalletError ? error.message : String(error),
                          ),
                        )
                    }}
                  >
                    Switch to Sepolia
                  </button>
                ) : null}
              </>
            ) : (
              <button
                className="secondary"
                disabled={!walletAvailable || walletBusy}
                onClick={() => {
                  setWalletBusy(true)
                  setWalletError(null)
                  void reconnect().finally(() => setWalletBusy(false))
                }}
              >
                Connect wallet (optional)
              </button>
            )}
          </div>
          <p className="small muted">
            Reading profiles is an <code>eth_call</code>, so everything below works with the
            wallet disconnected. Connecting only shows your address and network.
          </p>
          {walletError ? <Note tone="warn">{walletError}</Note> : null}
        </div>
      </header>

      {healthError ? (
        <Note tone="error">
          The server is not reachable: {healthError}. Start it with{' '}
          <code>npm run dev</code> (or <code>npm start</code> after <code>npm run build</code>).
        </Note>
      ) : null}

      {index?.simulated ? (
        <Note tone="warn">
          <strong>Simulated community.</strong> These are the planned demo records held
          locally — they have <strong>not</strong> been published to Sepolia. Live ENS reads
          are attempted first on every refresh. See <code>docs/profile-format.md</code> for the
          publishing procedure.
        </Note>
      ) : null}

      {/* -------------------------------------------------------- community */}
      <section className="card">
        <div className="card-head">
          <h2>Community index</h2>
          <p>
            Member list read from <code>{index?.rosterRecordKey ?? 'com.peoplefinder.members'}</code>{' '}
            on <code>{index?.root ?? health?.config.communityRoot ?? '…'}</code>. {rosterLabel}.
          </p>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="grow">
              <div className="status-line">
                <span className={index?.status === 'error' ? 'dot err' : 'dot'} aria-hidden />
                <strong>{statusLabel}</strong>
                <span className="muted small">· refreshed {formatTime(index?.refreshedAt ?? null)}</span>
                {index?.durationMs !== null && index?.durationMs !== undefined ? (
                  <span className="muted small">· took {index.durationMs} ms</span>
                ) : null}
              </div>
            </div>
            <button onClick={() => void refreshCommunity()} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh from Sepolia'}
            </button>
          </div>

          {refreshError ? <Note tone="error">{refreshError}</Note> : null}
          {index?.error ? <Note tone="error">{index.error}</Note> : null}

          {index?.notices.length ? (
            <ul className="notices">
              {index.notices.map((notice, i) => (
                <li key={i}>{notice}</li>
              ))}
            </ul>
          ) : null}

          {index && index.partial ? (
            <Note tone="warn">
              Coverage is incomplete: {index.failedProfiles.length} name(s) failed to read (
              {index.failedProfiles.join(', ') || 'unknown'}) and {index.emptyProfiles.length}{' '}
              carried no profile records ({index.emptyProfiles.join(', ') || 'none'}). Those
              people cannot be found until their records are published.
            </Note>
          ) : null}

          {index && index.rejectedNames.length > 0 ? (
            <Note tone="warn">
              Skipped {index.rejectedNames.length} roster entr
              {index.rejectedNames.length === 1 ? 'y' : 'ies'} that are not valid ENS names:{' '}
              {index.rejectedNames.map((r) => r.rawName).join(', ')}
            </Note>
          ) : null}

          {index && index.memberCount === 0 && index.status !== 'error' ? (
            <Note tone="info">
              Nothing indexed yet. Publish the roster and profile records described in{' '}
              <code>docs/profile-format.md</code>, then press refresh.
            </Note>
          ) : null}

          {index && index.profiles.length > 0 ? (
            <div className="people-grid">
              {index.profiles.map((profile) => (
                <article className="person" key={profile.ensName}>
                  <header>
                    <div>
                      <h3>{profile.fields.displayName ?? profile.ensName}</h3>
                      <code className="ens">{profile.ensName}</code>
                    </div>
                    <div className="badges">
                      <AvailabilityPill value={profile.fields.availability} />
                      {profile.suspicious ? <Badge tone="danger">hostile text</Badge> : null}
                      <Badge tone={profile.source === 'ens' ? 'ok' : 'warn'}>
                        {profile.source === 'ens' ? 'live ENS read' : 'simulated'}
                      </Badge>
                    </div>
                  </header>

                  {profile.fields.role ? <p className="role">{profile.fields.role}</p> : null}

                  {profile.fields.skills.length > 0 ? (
                    <p className="skills">
                      {profile.fields.skills.map((skill) => (
                        <span className="chip" key={skill}>
                          {skill}
                        </span>
                      ))}
                    </p>
                  ) : null}

                  {profile.fields.bio ? <p className="bio">{profile.fields.bio}</p> : null}

                  {profile.warnings.length > 0 ? (
                    <details>
                      <summary>
                        {profile.warnings.length} validation note
                        {profile.warnings.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="warn-list">
                        {profile.warnings.map((warning, i) => (
                          <li key={i}>
                            <code>{warning.field}</code> · {warning.detail}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <details>
                    <summary>ENS record status</summary>
                    <ul className="record-list">
                      {Object.entries(profile.recordStatus).map(([field, status]) => (
                        <li key={field}>
                          <span className={`status-tag ${status}`}>{status}</span>
                          <code>{field}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* --------------------------------------------------------------- ask */}
      <section className="card">
        <div className="card-head">
          <h2>Ask who can help</h2>
          <p>
            Retrieval is deterministic and bounded, so the same question gives the same
            candidates every time. Only those candidates can come back.
          </p>
        </div>
        <div className="card-body">
          <form onSubmit={ask}>
            <label className="field">
              <span>Your question, in plain language</span>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Who can mentor me in Rust this month?"
                maxLength={500}
                disabled={asking}
              />
            </label>
            <div className="row">
              <button type="submit" disabled={asking || question.trim().length < 3}>
                {asking ? 'Asking…' : 'Find people'}
              </button>
              {result ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void refreshCommunity()}
                  disabled={refreshing}
                >
                  Profiles changed? Refresh first
                </button>
              ) : null}
            </div>
          </form>

          {examples.length > 0 ? (
            <>
              <hr className="sep" />
              <p className="small muted">
                Recorded test queries from <code>docs/expected-queries.md</code>, with the
                members each one is expected to return. Click one to run it.
              </p>
              <div className="examples">
                {examples.map((testCase) => (
                  <button
                    key={testCase.id}
                    type="button"
                    className="example"
                    onClick={() => setQuestion(testCase.question)}
                    disabled={asking}
                  >
                    <span className="q">{testCase.question}</span>
                    <span className="e">
                      {testCase.expect === 'no-match'
                        ? 'expected: nobody fits'
                        : `expected: ${testCase.mustInclude.map(shortName).join(', ') || 'some members'}`}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {askError ? <Note tone="error">{askError}</Note> : null}
        </div>
      </section>

      {/* ----------------------------------------------------------- result */}
      {result ? <ResultPanel result={result} /> : null}

      <footer className="footer">
        <p className="small muted">
          ENS text records are public and owner-written, so every profile here is treated as
          untrusted input: it is length-bounded and sanitised on the way in, kept out of the
          model's instructions, and the model's answer is checked against the retrieved
          candidates before anything is displayed. Read-only lookups need no wallet and no
          transaction. Demo MVP — not production.
        </p>
      </footer>
    </div>
  )
}

function shortName(ens: string): string {
  const label = ens.split('.')[0] ?? ens
  return label
}

function ResultPanel({ result }: { result: FindResult }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{result.headline}</h2>
        <p>
          Asked: <em>{result.question}</em> · retrieved{' '}
          {result.retrieval.candidatesSent} of {result.retrieval.considered} indexed profiles
          (top-k {result.retrieval.topK}, score floor {result.retrieval.minScore}) · index
          refreshed {formatTime(result.retrieval.indexRefreshedAt)}
        </p>
      </div>

      <div className="card-body">
        {result.noMatch ? (
          <div className="nomatch">
            <h3>{result.headline}</h3>
            <p>{result.noMatchReason}</p>
            <p className="small muted">
              {result.model.used
                ? 'The model was asked to choose from the retrieved candidates and returned no one.'
                : `No model request was made. ${result.model.skippedReason ?? ''}`}
            </p>
          </div>
        ) : (
          <div className="matches">
            {result.matches.map((person, index) => (
              <article className="match" key={person.ensName}>
                <div className="match-head">
                  <span className="rank">{index + 1}</span>
                  <div>
                    <h3>{person.displayLabel}</h3>
                    <code className="ens">{person.ensName}</code>
                  </div>
                  <div className="badges">
                    <AvailabilityPill value={person.availability} />
                    {person.suspicious ? <Badge tone="danger">hostile text</Badge> : null}
                    <Badge tone={person.source === 'ens' ? 'ok' : 'warn'}>
                      {person.source === 'ens' ? 'live ENS read' : 'simulated'}
                    </Badge>
                  </div>
                </div>
                <p className="reason">{person.reason}</p>
                <p className="evidence">
                  <strong>From the ENS records:</strong> {person.evidence}
                </p>
                <p className="small muted">
                  matched on: {person.matchedTerms.join(', ') || '—'} · retrieval score{' '}
                  {person.retrievalScore}
                </p>
              </article>
            ))}
          </div>
        )}

        {result.rejected.length > 0 ? (
          <Note tone="warn">
            <strong>
              {result.rejected.length} name{result.rejected.length === 1 ? '' : 's'} from the
              model {result.rejected.length === 1 ? 'was' : 'were'} removed before display.
            </strong>{' '}
            <ul className="rejected-list">
              {result.rejected.map((rejection, i) => (
                <li key={i}>
                  <code>{rejection.rawName}</code> — {rejection.detail}
                </li>
              ))}
            </ul>
          </Note>
        ) : null}

        {result.unavailableNearMisses.length > 0 ? (
          <Note tone="info">
            <strong>Not matches — marked unavailable.</strong>{' '}
            {result.unavailableNearMisses.map((person) => (
              <span key={person.ensName}>
                <code>{person.ensName}</code> ({person.availability})
              </span>
            ))}{' '}
            These were retrieved but excluded because you asked whether anyone has time. They
            were never sent to the model and are not shown as recommendations.
          </Note>
        ) : null}

        <div className="meta">
          <span>model: {result.model.used ? result.model.model : 'not called'}</span>
          {result.model.providerHost ? <span>via {result.model.providerHost}</span> : null}
          {result.model.durationMs !== null ? (
            <span>{result.model.durationMs} ms</span>
          ) : null}
          {result.model.attempts !== null ? (
            <span>{result.model.attempts} attempt(s)</span>
          ) : null}
          <span>candidates sent: {result.retrieval.candidatesSent}</span>
        </div>

        {result.retrieval.candidates.length > 0 ? (
          <details>
            <summary>Candidates retrieved ({result.retrieval.candidates.length})</summary>
            <ul className="record-list">
              {result.retrieval.candidates.map((candidate) => (
                <li key={candidate.ensName}>
                  <code>{candidate.ensName}</code> — score {candidate.score} · matched{' '}
                  {candidate.matchedTerms.join(', ') || '—'}
                  {result.model.used ? '' : ' · not sent (no model request)'}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {result.model.messages ? (
          <details>
            <summary>Exactly what was sent to the model ({result.model.messages.length} messages)</summary>
            {result.model.messages.map((message, i) => (
              <div key={i}>
                <p className="small muted" style={{ marginBottom: 4 }}>
                  message {i + 1} — role: <code>{message.role}</code>
                  {message.role === 'system' ? ' (app-authored only)' : ''}
                </p>
                <pre className="dump">{message.content}</pre>
              </div>
            ))}
            {result.model.rawOutput ? (
              <>
                <p className="small muted" style={{ margin: '10px 0 4px' }}>
                  Raw model output
                </p>
                <pre className="dump">{result.model.rawOutput}</pre>
              </>
            ) : null}
          </details>
        ) : null}
      </div>
    </section>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}