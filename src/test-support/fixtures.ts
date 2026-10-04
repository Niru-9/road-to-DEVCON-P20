/**
 * Test fixtures.
 *
 * `retrieveCandidates` consumes `CandidateProfile`, which is a `CommunityProfile` plus the
 * retrieval verdict (score, matched terms, evidence). Building those by hand in every test
 * file invites drift, so the projections live here.
 */

import { displayLabel, evidenceLine, validateProfile } from '../shared/profile'
import type { Availability, CommunityProfile } from '../shared/profile'
import type { CandidateProfile } from '../shared/retrieval'

export interface ProfileSpec {
  displayName?: string | null
  role?: string | null
  skills?: string[]
  availability?: Availability | null
  bio?: string | null
}

/** A `CommunityProfile` with sensible record statuses, as if read live from ENS. */
export function makeProfile(ensName: string, spec: ProfileSpec = {}): CommunityProfile {
  return validateProfile({
    ensName,
    records: {
      name: spec.displayName ?? null,
      'com.peoplefinder.role': spec.role ?? null,
      'com.peoplefinder.skills': spec.skills?.join(', ') ?? null,
      'com.peoplefinder.availability': spec.availability ?? null,
      description: spec.bio ?? null,
    },
  })
}

/** Attach a retrieval verdict to a profile, for tests about what gets sent or displayed. */
export function asCandidate(
  profile: CommunityProfile,
  overrides: Partial<CandidateProfile> = {},
): CandidateProfile {
  return {
    ensName: profile.ensName,
    displayLabel: displayLabel(profile),
    score: 3,
    matchedTerms: ['rust'],
    evidence: evidenceLine(profile),
    fields: profile.fields,
    source: profile.source,
    suspicious: profile.suspicious,
    ...overrides,
  }
}

/** The common case: build a profile and immediately treat it as a candidate. */
export function candidateFor(ensName: string, spec: ProfileSpec = {}): CandidateProfile {
  return asCandidate(makeProfile(ensName, spec))
}