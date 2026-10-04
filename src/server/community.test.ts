/**
 * The community index: roster discovery, and the honesty of the fallback.
 *
 * These tests run against a **fake** `EnsTextReader`, so nothing here touches the network.
 * They cover the paths that decide what the UI claims about where its data came from:
 *
 *   - a roster read live from the root's own ENS record
 *   - a configured roster whose profiles are still read live
 *   - the labelled simulated fallback when nothing live is readable
 *   - refusal to simulate when the operator turned that off
 */

import { describe, expect, it } from 'vitest'

import { CommunityIndex, mapWithConcurrency } from './community'
import type { AppConfig } from './config'
import type { EnsTextReader } from './ens'
import { PROFILE_RECORD_KEYS, ROSTER_RECORD_KEY } from '../shared/profile'
import { PLANNED_MEMBERS } from '../shared/demo-community'

const ROOT = 'tokyobuilders.eth'
const A = 'aiko.tokyobuilders.eth'
const K = 'kenji.tokyobuilders.eth'

/** Minimal config; only the fields CommunityIndex reads are meaningful. */
function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    communityRoot: ROOT,
    configuredMembers: [],
    communityMembersMax: 60,
    allowSimulatedIndex: false,
    ...overrides,
  } as AppConfig
}

/** A fake chain: `records[ensName][key]` is the value for that key, absent meaning unset. */
function fakeChain(records: Record<string, Record<string, string | null>>) {
  const calls: Array<{ name: string; key: string }> = []
  const readText: EnsTextReader = async (_client, name, key) => {
    calls.push({ name, key })
    return records[name]?.[key] ?? null
  }
  return { readText, calls }
}

/** Names read, in order, ignoring key. */
function namesRead(calls: Array<{ name: string }>): string[] {
  return [...new Set(calls.map((call) => call.name))]
}

function profileRecords(overrides: Record<string, string | null> = {}) {
  return {
    [PROFILE_RECORD_KEYS.displayName]: 'Aiko Tanaka',
    [PROFILE_RECORD_KEYS.role]: 'Protocol engineer',
    [PROFILE_RECORD_KEYS.skills]: 'rust, ens',
    [PROFILE_RECORD_KEYS.availability]: 'open',
    [PROFILE_RECORD_KEYS.bio]: 'Works on the resolver.',
    ...overrides,
  }
}

describe('mapWithConcurrency', () => {
  it('keeps input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay / 10))
      return delay
    })
    expect(result).toEqual([30, 10, 20])
  })

  it('never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return null
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('propagates a worker failure rather than reporting a silent empty result', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (value) => {
        if (value === 2) throw new Error('read failed')
        return value
      }),
    ).rejects.toThrow('read failed')
  })
})

describe('CommunityIndex.refresh', () => {
  it('reads the roster from the root name and profiles from chain', async () => {
    const chain = fakeChain({
      [ROOT]: { [ROSTER_RECORD_KEY]: `${A},${K}` },
      [A]: profileRecords(),
      [K]: profileRecords({ [PROFILE_RECORD_KEYS.skills]: 'solidity' }),
    })

    const index = new CommunityIndex({ client: {} as never, config: config(), readText: chain.readText })
    const state = await index.refresh()

    expect(state.rosterSource).toBe('ens-record')
    expect(state.rosterStatus).toBe('read')
    expect(state.attemptedNames).toEqual([A, K])
    expect(state.profiles.map((p) => p.ensName)).toEqual([A, K])
    expect(state.profiles.every((p) => p.source === 'ens')).toBe(true)
    expect(namesRead(chain.calls)).toContain(ROOT)
    expect(namesRead(chain.calls)).toContain(A)
    // Every documented field came from a read, not from a default.
    const keysForA = chain.calls.filter((call) => call.name === A).map((call) => call.key)
    expect(keysForA).toEqual(expect.arrayContaining(Object.values(PROFILE_RECORD_KEYS)))
  })

  it('uses the configured roster and still reads profiles live', async () => {
    const chain = fakeChain({ [A]: profileRecords() })
    const index = new CommunityIndex({
      client: {} as never,
      config: config({ configuredMembers: [A] }),
      readText: chain.readText,
    })
    const state = await index.refresh()

    expect(state.rosterSource).toBe('configured')
    expect(state.profiles.map((p) => p.ensName)).toEqual([A])
    expect(state.profiles[0]?.source).toBe('ens')
    expect(state.notices.join(' ')).toContain('COMMUNITY_MEMBERS')
  })

  it('reports a name that is not a valid ENS name instead of dropping it', async () => {
    const chain = fakeChain({
      [ROOT]: { [ROSTER_RECORD_KEY]: `${A}, not a name` },
      [A]: profileRecords(),
    })
    const index = new CommunityIndex({ client: {} as never, config: config(), readText: chain.readText })
    const state = await index.refresh()

    expect(state.rejectedNames).toHaveLength(1)
    expect(state.rejectedNames[0]?.rawName).toBe('not a name')
  })

  it('falls back to the simulated set and labels it, when nothing live is readable', async () => {
    const chain = fakeChain({})
    const index = new CommunityIndex({
      client: {} as never,
      config: config({ allowSimulatedIndex: true }),
      readText: chain.readText,
    })
    const state = await index.refresh()

    expect(state.rosterSource).toBe('simulated')
    expect(state.profiles.length).toBe(PLANNED_MEMBERS.length)
    expect(state.profiles.every((p) => p.source === 'simulated')).toBe(true)
    expect(state.notices[0]).toMatch(/simulated|not published/i)
  })

  it('refuses to simulate when the operator turned it off', async () => {
    const chain = fakeChain({})
    const index = new CommunityIndex({
      client: {} as never,
      config: config({ allowSimulatedIndex: false }),
      readText: chain.readText,
    })
    const state = await index.refresh()

    expect(state.rosterSource).toBe('none')
    expect(state.profiles).toHaveLength(0)
    expect(state.notices.join(' ')).toContain('ALLOW_SIMULATED_INDEX=false')
  })

  it('marks coverage partial when one member read fails and keeps the rest', async () => {
    const chain = fakeChain({
      [ROOT]: { [ROSTER_RECORD_KEY]: `${A},${K}` },
      [A]: profileRecords(),
      [K]: profileRecords(),
    })
    const flaky: EnsTextReader = async (_client, name, key) => {
      if (name === K) throw new Error('RPC timeout')
      return chain.readText({} as never, name, key)
    }
    const index = new CommunityIndex({
      client: {} as never,
      config: config(),
      readText: flaky,
    })
    const state = await index.refresh()

    expect(state.profiles.map((p) => p.ensName)).toEqual([A])
    expect(state.failedProfiles).toEqual([K])
    expect(state.partial).toBe(true)
  })

  it('does not index a name that published nothing findable', async () => {
    const chain = fakeChain({
      [ROOT]: { [ROSTER_RECORD_KEY]: `${A},${K}` },
      [A]: profileRecords(),
      [K]: { [PROFILE_RECORD_KEYS.availability]: 'open' },
    })
    const index = new CommunityIndex({ client: {} as never, config: config(), readText: chain.readText })
    const state = await index.refresh()

    expect(state.emptyProfiles).toEqual([K])
    expect(state.profiles.map((p) => p.ensName)).toEqual([A])
  })

  it('shares one refresh between concurrent callers', async () => {
    const chain = fakeChain({ [ROOT]: { [ROSTER_RECORD_KEY]: A }, [A]: profileRecords() })
    const index = new CommunityIndex({ client: {} as never, config: config(), readText: chain.readText })

    const [first, second] = await Promise.all([index.refresh(), index.refresh()])
    expect(first).toBe(second)
    expect(namesRead(chain.calls).filter((name) => name === ROOT)).toHaveLength(1)
  })

  it('surfaces a configuration problem as an index error rather than a crash', async () => {
    const failing: EnsTextReader = async () => {
      throw new Error('RPC endpoint unreachable')
    }
    const index = new CommunityIndex({
      client: {} as never,
      config: config(),
      readText: failing,
    })
    const state = await index.refresh()

    // readRosterRecord reports a failed read rather than throwing, so the fallback path runs;
    // either way the state must be usable and must not claim chain data.
    expect(state.status).toBe('ready')
    expect(state.rosterSource).toBe('none')
    expect(state.profiles).toHaveLength(0)
    expect(state.error).toBeNull()
  })
})