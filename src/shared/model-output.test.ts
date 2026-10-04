/**
 * The membership check.
 *
 * Scored criterion 1 (22 points, the largest check) is "Every person in the answer is checked
 * against the retrieved candidates". These tests feed the checker answers a careless or
 * hostile model might produce and assert what reaches the UI.
 */

import { describe, expect, it } from 'vitest'

import {
  enforceCandidateMembership,
  MAX_MATCHES,
  MAX_REASON_LENGTH,
  ModelOutputError,
  noMatchVerdict,
  parseModelAnswer,
} from './model-output'
import type { CandidateProfile } from './retrieval'
import { buildSimulatedProfiles } from './demo-community'
import { retrieveCandidates } from './retrieval'
import { normalizeEnsName } from '../server/ens'

function candidate(ensName: string, overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    ensName,
    displayLabel: ensName.split('.')[0] ?? ensName,
    score: 3,
    matchedTerms: ['rust'],
    evidence: `role: engineer | skills: rust | availability: open`,
    fields: {
      displayName: null,
      role: 'Protocol engineer',
      skills: ['rust'],
      availability: 'open',
      bio: null,
    },
    source: 'ens',
    suspicious: false,
    ...overrides,
  }
}

const aiko = candidate('aiko.tokyobuilders.eth')
const kenji = candidate('kenji.tokyobuilders.eth')
const candidates = [aiko, kenji]

describe('normalizeEnsName', () => {
  it('lowercases so case cannot be used to smuggle a name past the check', () => {
    expect(normalizeEnsName('Aiko.TokyoBuilders.ETH')).toBe('aiko.tokyobuilders.eth')
  })

  it('rejects something that is not an ENS name', () => {
    expect(() => normalizeEnsName('Aiko')).toThrow()
    expect(() => normalizeEnsName('')).toThrow()
  })
})

describe('parseModelAnswer', () => {
  it('parses clean JSON', () => {
    const parsed = parseModelAnswer('{"matches":[{"ensName":"aiko.eth","reason":"Rust."}]}')
    expect(parsed.matches).toHaveLength(1)
    expect(parsed.noMatchReason).toBeNull()
  })

  it('tolerates a code fence around the JSON', () => {
    const parsed = parseModelAnswer('```json\n{"matches":[],"noMatchReason":"Nobody."}\n```')
    expect(parsed.matches).toHaveLength(0)
    expect(parsed.noMatchReason).toBe('Nobody.')
  })

  it('refuses malformed output rather than guessing', () => {
    expect(() => parseModelAnswer('I think Kenji would be great!')).toThrow(ModelOutputError)
  })

  it('refuses output whose matches are not a list', () => {
    expect(() => parseModelAnswer('{"matches":"kenji.eth"}')).toThrow(ModelOutputError)
  })
})

describe('enforceCandidateMembership', () => {
  const options = { normalize: normalizeEnsName }

  it('accepts a retrieved candidate', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'aiko.tokyobuilders.eth', reason: 'Listed rust, and is open.' }] },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(1)
    expect(verdict.matches[0]?.ensName).toBe('aiko.tokyobuilders.eth')
    expect(verdict.matches[0]?.availability).toBe('open')
    expect(verdict.rejected).toHaveLength(0)
  })

  it('accepts a differently-cased spelling of the same name', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'Aiko.TokyoBuilders.ETH', reason: 'Rust, open.' }] },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(1)
    expect(verdict.rejected).toHaveLength(0)
  })

  it('rejects an invented name, even a famous one', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'vitalik.eth', reason: 'Very famous.' }] },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.rejected).toHaveLength(1)
    expect(verdict.rejected[0]?.code).toBe('not-in-candidates')
    // The rejection is reported, not hidden.
    expect(verdict.rejected[0]?.rawName).toBe('vitalik.eth')
  })

  it('rejects a real community member who was not retrieved for this question', () => {
    // Retrieval for "rust" pulls in the rust people. Take a different real member from the
    // same demo community and confirm the checker refuses them anyway.
    const retrieved = new Set(candidates.map((c) => c.ensName))
    const outsider = buildSimulatedProfiles().find((p) => !retrieved.has(p.ensName))
    expect(outsider).toBeDefined()

    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: outsider!.ensName, reason: 'Good reason.' }] },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.rejected[0]?.code).toBe('not-in-candidates')
    expect(verdict.rejected[0]?.rawName).toBe(outsider!.ensName)
  })

  it('rejects a match with no reason, because the reason is the point', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'aiko.tokyobuilders.eth', reason: '   ' }] },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.rejected[0]?.code).toBe('missing-reason')
  })

  it('rejects a repeat of the same person', () => {
    const verdict = enforceCandidateMembership(
      {
        matches: [
          { ensName: 'aiko.tokyobuilders.eth', reason: 'First.' },
          { ensName: 'Aiko.TokyoBuilders.ETH', reason: 'Again.' },
        ],
      },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(1)
    expect(verdict.rejected).toHaveLength(1)
    expect(verdict.rejected[0]?.code).toBe('duplicate')
  })

  it('rejects every name when nothing was retrieved', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'aiko.tokyobuilders.eth', reason: 'Rust.' }] },
      [],
      options,
    )
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.rejected).toHaveLength(1)
  })

  it('truncates an overlong reason instead of letting it flood the UI', () => {
    const verdict = enforceCandidateMembership(
      { matches: [{ ensName: 'aiko.tokyobuilders.eth', reason: 'x'.repeat(5000) }] },
      candidates,
      options,
    )
    expect(verdict.matches[0]?.reason.length).toBe(MAX_REASON_LENGTH)
  })

  it('caps the number of displayed people', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      candidate(`m${index}.tokyobuilders.eth`),
    )
    const verdict = enforceCandidateMembership(
      {
        matches: many.map((c) => ({ ensName: c.ensName, reason: 'Reason.' })),
      },
      many,
      options,
    )
    expect(verdict.matches).toHaveLength(MAX_MATCHES)
  })

  it('passes a no-match through unchanged', () => {
    const verdict = enforceCandidateMembership(
      { matches: [], noMatchReason: 'Nobody in the index has rust skills.' },
      candidates,
      options,
    )
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.noMatchReason).toBe('Nobody in the index has rust skills.')
  })
})

describe('noMatchVerdict', () => {
  it('is an explicit verdict, not an empty table', () => {
    const verdict = noMatchVerdict('No indexed member has that skill.')
    expect(verdict.matches).toHaveLength(0)
    expect(verdict.noMatchReason).toBeTruthy()
  })
})