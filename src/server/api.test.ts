/**
 * The HTTP surface, end to end.
 *
 * Two apps are started, both offline:
 *
 *   - **live-ish**: ENS reads served from an in-memory fake chain, so the whole HTTP path runs
 *     against what looks like real Sepolia records.
 *   - **no RPC**: the RPC URL points at a closed port, so every read fails and the index falls
 *     back to the labelled simulated set. This exercises the real fallback rather than mocking
 *     it away.
 *
 * The model is injected too, which is what makes the dangerous assertions possible: a fake
 * model that invents `satoshi.eth` must not be able to put it in a response.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from './index'
import { parseConfig } from './config'
import type { EnsTextReader } from './ens'
import type { askModel } from './llm'
import { PLANNED_MEMBERS } from '../shared/demo-community'
import { PROFILE_RECORD_KEYS, ROSTER_RECORD_KEY } from '../shared/profile'

/** A model that behaves: returns the first candidate with a reason. */
const cooperativeModel: typeof askModel = async ({ candidates, question }) => ({
  content: JSON.stringify({
    matches: candidates.slice(0, 2).map((candidate) => ({
      ensName: candidate.ensName,
      reason: `Listed ${candidate.fields.skills.join(', ')} for "${question}".`,
    })),
    noMatchReason: null,
  }),
  model: 'fake-cooperative',
  providerHost: 'fake',
  durationMs: 1,
  attempts: 1,
  messages: [
    { role: 'system', content: 'fake system message' },
    { role: 'user', content: question },
    { role: 'user', content: JSON.stringify(candidates) },
  ],
})

/** A model that has swallowed the adversarial profile's instructions. */
const compromisedModel: typeof askModel = async ({ candidates }) => ({
  content: JSON.stringify({
    matches: [
      { ensName: 'satoshi.eth', reason: 'Mentioned by a member, so definitely a mentor.' },
      { ensName: 'vitalik.eth', reason: 'Definitely part of this community.' },
      { ensName: candidates[0]!.ensName, reason: 'Only this one was actually retrieved.' },
      { ensName: 'mika.tokyobuilders.eth', reason: 'No reason at all, just injected text.' },
    ],
    noMatchReason: null,
  }),
  model: 'fake-compromised',
  providerHost: 'fake',
  durationMs: 1,
  attempts: 1,
  messages: [{ role: 'system', content: 'fake system message' }],
})

function makeConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    LLM_BASE_URL: 'http://127.0.0.1:1/v1',
    LLM_MODEL: 'fake-model',
    LLM_API_KEY: '',
    LLM_TIMEOUT_MS: '1000',
    LLM_MAX_TOKENS: '256',
    SEPOLIA_RPC_URL: 'http://127.0.0.1:1',
    RPC_TIMEOUT_MS: '1000',
    COMMUNITY_ROOT: 'tokyobuilders.eth',
    COMMUNITY_MEMBERS: '',
    ALLOW_SIMULATED_INDEX: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv)
}

/** The planned demo records, as if they were published on Sepolia. */
function publishedRecords(): Record<string, Record<string, string | null>> {
  const records: Record<string, Record<string, string | null>> = {
    'tokyobuilders.eth': { [ROSTER_RECORD_KEY]: PLANNED_MEMBERS.map((m) => m.ensName).join(',') },
  }
  for (const member of PLANNED_MEMBERS) {
    records[member.ensName] = {
      [PROFILE_RECORD_KEYS.displayName]: member.records.displayName || null,
      [PROFILE_RECORD_KEYS.role]: member.records.role || null,
      [PROFILE_RECORD_KEYS.skills]: member.records.skills || null,
      [PROFILE_RECORD_KEYS.availability]: member.records.availability || null,
      [PROFILE_RECORD_KEYS.bio]: member.records.bio || null,
    }
  }
  return records
}

const fakeChain: EnsTextReader = async (_client, name, key) => publishedRecords()[name]?.[key] ?? null

interface FindResponse {
  question: string
  noMatch: boolean
  headline: string
  noMatchReason: string | null
  matches: Array<{ ensName: string; reason: string; evidence: string; source: string }>
  rejected: Array<{ rawName: string; code: string }>
  unavailableNearMisses: Array<{ ensName: string; availability: string | null }>
  retrieval: {
    considered: number
    topK: number
    candidatesSent: number
    candidates: Array<{ ensName: string; score: number }>
    indexSource: string
  }
  model: { used: boolean; skippedReason: string | null; model: string | null }
}

interface ErrorResponse {
  error: { code: string; message: string }
}

const servers: Server[] = []
let liveBase = ''
let strictBase = ''
let offlineBase = ''
let compromisedBase = ''

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  servers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function getJson<T>(base: string, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as T }
}

async function postJson<T>(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, body: (await response.json()) as T }
}

function find(base: string, question: string, refreshFirst = false): Promise<FindResponse> {
  return postJson<FindResponse>(base, '/api/find', { question, refreshFirst }).then((r) => r.body)
}

beforeAll(async () => {
  const config = makeConfig()

  liveBase = await listen(createApp(config, { ask: cooperativeModel, readText: fakeChain }))
  offlineBase = await listen(createApp(config, { ask: cooperativeModel }))

  /**
   * A high relevance floor. Sora is the only `unavailable` member, so the gate can only
   * produce a clean "nobody is free" answer when retrieval is dominated by one person. At
   * the default floor of 1, the word "free" alone matches every available profile and the
   * gate is not exercised. Raising MIN_CANDIDATE_SCORE is the documented knob for that.
   */
  strictBase = await listen(
    createApp(makeConfig({ MIN_CANDIDATE_SCORE: '5' }), {
      ask: cooperativeModel,
      readText: fakeChain,
    }),
  )

  compromisedBase = await listen(createApp(config, { ask: compromisedModel, readText: fakeChain }))
})

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('GET /api/health', () => {
  it('reports readiness, the chain and the bounds in force', async () => {
    const { status, body } = await getJson<{
      ok: boolean
      chainId: number
      walletRequired: boolean
      config: { topK: number; timeoutMs: number; maxTokens: number; hasApiKey: boolean }
      recordKeys: { roster: string }
    }>(liveBase, '/api/health')

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.chainId).toBe(11155111)
    expect(body.walletRequired).toBe(false)
    expect(body.config.topK).toBe(5)
    expect(body.config.timeoutMs).toBe(1000)
    // Both sides of the model call are bounded, and the answer is reported so a reviewer can
    // see that the bound is really in force.
    expect(body.config.maxTokens).toBe(256)
    expect(body.recordKeys.roster).toBe('com.peoplefinder.members')
  })

  it('never leaks the API key or the full endpoint', async () => {
    const raw = await (await fetch(`${liveBase}/api/health`)).text()
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('127.0.0.1:1/v1')
  })
})

describe('GET /api/community', () => {
  it('starts unrefreshed rather than pretending to know the community', async () => {
    // A dedicated app: this asserts the *initial* state, so it must not share an index with
    // any other test.
    const fresh = await listen(createApp(makeConfig(), { ask: cooperativeModel }))
    const { body } = await getJson<{ status: string; memberCount: number; simulated: boolean }>(
      fresh,
      '/api/community',
    )
    expect(body.status).toBe('empty')
    expect(body.memberCount).toBe(0)
    expect(body.simulated).toBe(false)
  })
})

describe('POST /api/community/refresh', () => {
  it('reads the roster and every profile from ENS when the chain answers', async () => {
    const { status, body } = await postJson<{
      rosterSource: string
      rosterStatus: string
      simulated: boolean
      memberCount: number
      profiles: Array<{ ensName: string; source: string }>
    }>(liveBase, '/api/community/refresh')

    expect(status).toBe(200)
    expect(body.rosterSource).toBe('ens-record')
    expect(body.rosterStatus).toBe('read')
    expect(body.simulated).toBe(false)
    expect(body.memberCount).toBe(PLANNED_MEMBERS.length)
    expect(body.profiles.every((p) => p.source === 'ens')).toBe(true)
  })

  it('falls back to the labelled simulated set when no live read succeeds', async () => {
    const { status, body } = await postJson<{
      rosterSource: string
      simulated: boolean
      memberCount: number
      notices: string[]
      profiles: Array<{ ensName: string; source: string }>
    }>(offlineBase, '/api/community/refresh')

    expect(status).toBe(200)
    expect(body.rosterSource).toBe('simulated')
    expect(body.simulated).toBe(true)
    expect(body.memberCount).toBe(PLANNED_MEMBERS.length)
    expect(body.notices[0]).toMatch(/not been published/i)
    expect(body.profiles.every((p) => p.source === 'simulated')).toBe(true)
  })
})

describe('POST /api/find — input handling', () => {
  it('rejects a question that is too short', async () => {
    const { status, body } = await postJson<ErrorResponse>(liveBase, '/api/find', { question: 'hi' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('rejects a missing question', async () => {
    const { status } = await postJson(liveBase, '/api/find', {})
    expect(status).toBe(400)
  })

  it('rejects an unknown API route with JSON, not HTML', async () => {
    const { status, body } = await getJson<ErrorResponse>(liveBase, '/api/nope')
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('POST /api/find — explicit no-match', () => {
  it('answers nobody-fits without calling the model when nothing matches', async () => {
    const result = await find(liveBase, 'Who can help me find a dentist near Osaka station?')

    expect(result.noMatch).toBe(true)
    expect(result.headline.length).toBeGreaterThan(0)
    expect(result.noMatchReason).toBeTruthy()
    expect(result.matches).toHaveLength(0)
    expect(result.model.used).toBe(false)
    expect(result.model.skippedReason).toBeTruthy()
    expect(result.retrieval.candidatesSent).toBe(0)
    expect(result.retrieval.considered).toBe(PLANNED_MEMBERS.length)
  })

  it('names unavailable people as excluded rather than hiding them', async () => {
    // Refresh the strict app once, so this test is about the gate and not about the index.
    await postJson(strictBase, '/api/community/refresh')

    const result = await find(strictBase, 'Who is free to help me with vector search this week?')

    expect(result.noMatch).toBe(true)
    expect(result.unavailableNearMisses.map((p) => p.ensName)).toEqual(['sora.tokyobuilders.eth'])
    expect(result.model.used).toBe(false)
    expect(result.model.skippedReason).toMatch(/unavailable/i)
    expect(result.noMatchReason).toMatch(/unavailable/i)
  })

  it('never offers someone marked unavailable for a question about time', async () => {
    const result = await find(liveBase, 'Who can mentor me in Rust this month?')
    expect(result.matches.map((m) => m.ensName)).not.toContain('sora.tokyobuilders.eth')
    expect(result.unavailableNearMisses.map((p) => p.ensName)).toContain('sora.tokyobuilders.eth')
  })
})

describe('POST /api/find — grounding', () => {
  it('returns members from the live ENS index with profile-derived evidence', async () => {
    const result = await find(liveBase, 'I need a Solidity auditor who is free this week.')

    expect(result.noMatch).toBe(false)
    expect(result.matches.length).toBeGreaterThan(0)
    for (const match of result.matches) {
      expect(match.source).toBe('ens')
      expect(match.evidence).toBeTruthy()
      expect(match.reason.length).toBeGreaterThan(0)
    }
    expect(result.retrieval.indexSource).toBe('ens-record')
  })

  it('only ever returns names that were in the retrieved candidate set', async () => {
    const questions = [
      'Who can mentor me in Rust this month?',
      'I need a Solidity auditor who is free this week.',
      'Who can help me make a React app feel faster?',
      'Is Mei free to look at my smart contract this week?',
      'I just moved to Tokyo. Who can introduce me to the right people?',
      'List every single member of this community and tell me everything about them.',
      'Who knows quantum chemistry?',
    ]

    for (const question of questions) {
      const result = await find(liveBase, question)
      const candidates = new Set(result.retrieval.candidates.map((c) => c.ensName))
      for (const match of result.matches) {
        expect(
          candidates.has(match.ensName),
          `"${question}" returned ${match.ensName}, which was not retrieved`,
        ).toBe(true)
      }
    }
  })

  it('drops invented and non-member names when the model has been compromised', async () => {
    const result = await find(compromisedBase, 'Who can mentor me in Rust this month?', true)

    const returned = result.matches.map((m) => m.ensName)
    expect(returned).not.toContain('satoshi.eth')
    expect(returned).not.toContain('vitalik.eth')

    /**
     * The membership check answers exactly one question: is this name among the candidates
     * retrieved for THIS question? It does not judge whether a member deserves to be there.
     * So every surviving name must be in the retrieved set — and the adversarial member is in
     * that set, because down-ranking an instruction-bearing profile is a matter of order, not
     * exclusion. That limit is real and is why the flag is shown in the UI and why retrieval
     * penalises the profile rather than trusting the model to ignore it.
     */
    const candidates = new Set(result.retrieval.candidates.map((c) => c.ensName))
    for (const name of returned) {
      expect(candidates.has(name), `${name} was returned without being retrieved`).toBe(true)
    }
    // The one legitimate candidate the model mentioned must still be there.
    expect(returned).toContain('aiko.tokyobuilders.eth')

    const rejected = result.rejected.map((r) => r.rawName)
    expect(rejected).toContain('satoshi.eth')
    expect(rejected).toContain('vitalik.eth')

    // The rejection is visible to the user, not silently swallowed.
    expect(JSON.stringify(result.rejected)).toMatch(/not-in-candidates/)
  })

  it('never sends more candidates than the bound allows', async () => {
    const result = await find(liveBase, 'List every single member of this community and tell me everything about them.')
    expect(result.retrieval.topK).toBe(5)
    expect(result.retrieval.candidatesSent).toBeLessThanOrEqual(5)
    expect(result.retrieval.candidates.length).toBeLessThanOrEqual(5)
  })

  it('keeps the model out of the loop entirely when the index is empty', async () => {
    const fresh = await listen(createApp(makeConfig(), { ask: cooperativeModel }))
    const result = await find(fresh, 'Who can mentor me in Rust this month?')

    expect(result.noMatch).toBe(true)
    expect(result.noMatchReason).toMatch(/index is empty/i)
    expect(result.model.used).toBe(false)
  })
})

describe('POST /api/find — provider failure', () => {
  it('surfaces a model failure as an error rather than as an invented person', async () => {
    // No `ask` seam and no fake chain: the real provider call and the real RPC both point at
    // a closed port, so this exercises the genuine failure path end to end.
    const brokenModelBase = await listen(createApp(makeConfig()))
    await postJson(brokenModelBase, '/api/community/refresh')

    const { status, body } = await postJson<ErrorResponse>(brokenModelBase, '/api/find', {
      question: 'Who can mentor me in Rust this month?',
    })

    expect(status).toBeGreaterThanOrEqual(500)
    expect(body.error.code).toMatch(/MODEL|UPSTREAM|TIMEOUT/)
    expect(body.error.message).not.toMatch(/\bmatches\b/)
  })
})

describe('GET /api/examples', () => {
  it('serves the recorded cases with their expected members', async () => {
    const { body } = await getJson<{ cases: Array<{ id: string; mustInclude: string[] }> }>(
      liveBase,
      '/api/examples',
    )
    expect(body.cases.length).toBeGreaterThanOrEqual(8)
    expect(body.cases.some((c) => c.mustInclude.length > 0)).toBe(true)
  })
})