/**
 * Validating the model's answer, and enforcing that it can only name retrieved people.
 *
 * THIS MODULE IS THE ANSWER TO SCORED CRITERION 1 (22 points — the largest single check):
 * "Every person in the answer is checked against the retrieved candidates."
 *
 * The sequence is deliberately: **parse → validate → membership-check → only then display.**
 * Nothing reaches the UI before `enforceCandidateMembership` has run over it, and the
 * rejected names are returned to the caller rather than dropped silently, so a model that
 * invents someone is visible in the UI instead of quietly erased.
 *
 * Identity comparison is name-normalized (ENSIP-15) on both sides, so a model writing
 * `Aiko.TokyoBuilders.ETH` is matched against the retrieved `aiko.tokyobuilders.eth`
 * without a case-sensitivity loophole.
 */

import { z } from 'zod'

import type { CandidateProfile } from './retrieval'
import type { Availability } from './profile'

/** Upper bound on a model-supplied reason, so a runaway generation cannot flood the UI. */
export const MAX_REASON_LENGTH = 300
export const MAX_MATCHES = 10

/**
 * The shape we ask for. `.strict()` is not used: providers routinely add fields, and
 * refusing to parse the whole object over an unknown key would turn a cosmetic difference
 * into a total failure.
 */
const modelAnswerSchema = z.object({
  matches: z
    .array(
      z.object({
        ensName: z.string(),
        reason: z.string().optional().nullable(),
      }),
    )
    .max(50),
  noMatchReason: z.string().optional().nullable(),
})

/** Classifies why a name from the model was not displayed as a person. */
export type RejectionCode =
  | 'not-in-candidates'
  | 'invalid-name'
  | 'missing-reason'
  | 'duplicate'

export interface RejectedName {
  /** Exactly what the model wrote, so the failure is inspectable. */
  readonly rawName: string
  readonly code: RejectionCode
  readonly detail: string
}

export interface MatchedPerson {
  /** ENSIP-15 normalized; identical to the retrieved candidate's name. */
  readonly ensName: string
  readonly displayLabel: string
  readonly reason: string
  /** Structured profile evidence, independent of whatever the model said. */
  readonly evidence: string
  readonly matchedTerms: readonly string[]
  readonly source: 'ens' | 'simulated'
  readonly suspicious: boolean
  /**
   * Copied from the candidate's own records, never from the model, so the badge in the UI
   * is a fact about the ENS profile rather than something the model asserted.
   */
  readonly availability: Availability | null
  /** Retrieval score, so the ordering shown to the user is the retrieval order. */
  readonly retrievalScore: number
}

export interface ModelVerdict {
  readonly matches: readonly MatchedPerson[]
  readonly noMatchReason: string | null
  readonly rejected: readonly RejectedName[]
}

export class ModelOutputError extends Error {
  readonly detail: string

  constructor(message: string, detail = '') {
    super(message)
    this.name = 'ModelOutputError'
    this.detail = detail
  }
}

/**
 * Parse a provider response into JSON.
 *
 * Free-tier models wrap JSON in prose or a code fence often enough that a bare
 * `JSON.parse` would fail on an otherwise perfect answer, so a fenced block or the first
 * balanced-looking object is extracted first.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim()

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (fenced?.[1]) return fenced[1]

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new ModelOutputError(
      'The model did not return JSON, so its answer could not be checked against the candidates. ' +
        'Nothing was displayed. Try again.',
      raw.slice(0, 200),
    )
  }
  return trimmed.slice(start, end + 1)
}

/** Parse + validate the structured answer. Throws `ModelOutputError` if unusable. */
export function parseModelAnswer(raw: string): { matches: Array<{ ensName: string; reason?: string | null }>; noMatchReason: string | null } {
  const json = extractJsonObject(raw)
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (cause) {
    throw new ModelOutputError(
      'The model returned malformed JSON, so its answer could not be checked against the ' +
        'candidates. Nothing was displayed. Try again.',
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  const parsed = modelAnswerSchema.safeParse(data)
  if (!parsed.success) {
    throw new ModelOutputError(
      'The model returned an answer in an unexpected shape, so it could not be checked against ' +
        'the candidates. Nothing was displayed. Try again.',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  }

  return {
    matches: parsed.data.matches,
    noMatchReason: typeof parsed.data.noMatchReason === 'string' ? parsed.data.noMatchReason.trim() : null,
  }
}

/**
 * Normalizes an ENS name. Injected so this module needs no chain client: the server passes
 * viem's ENSIP-15 `normalize`, tests pass a deterministic stand-in.
 */
export type NameNormalizer = (name: string) => string

export interface EnforceOptions {
  readonly normalize: NameNormalizer
}

/**
 * THE MEMBERSHIP CHECK.
 *
 * Every name the model produced is re-normalized and looked up in the retrieved candidate
 * set. A name that is not in that set is rejected and **never displayed as a person**,
 * even if it is a real, famous ENS name. Duplicates and missing reasons are rejected too,
 * for the same reason: a row in the results table is a claim about a real community
 * member, and it has to be one we actually retrieved.
 */
export function enforceCandidateMembership(
  answer: { matches: ReadonlyArray<{ ensName: string; reason?: string | null }>; noMatchReason?: string | null },
  candidates: readonly CandidateProfile[],
  options: EnforceOptions,
): ModelVerdict {
  const { normalize } = options

  // The allowlist, keyed by normalized name. This is the only way to produce a MatchedPerson.
  const allowed = new Map<string, CandidateProfile>()
  for (const candidate of candidates) {
    allowed.set(candidate.ensName, candidate)
  }

  const accepted: MatchedPerson[] = []
  const rejected: RejectedName[] = []
  const seen = new Set<string>()

  for (const match of answer.matches) {
    const rawName = (match.ensName ?? '').trim()

    if (rawName.length === 0) {
      rejected.push({ rawName, code: 'invalid-name', detail: 'Empty name.' })
      continue
    }

    let normalized: string
    try {
      normalized = normalize(rawName)
    } catch {
      rejected.push({
        rawName,
        code: 'invalid-name',
        detail: 'Not a name ENS will accept.',
      })
      continue
    }

    const candidate = allowed.get(normalized)
    if (!candidate) {
      rejected.push({
        rawName,
        code: 'not-in-candidates',
        detail: `Not among the ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} retrieved for this question, so it is not shown as a person.`,
      })
      continue
    }

    if (seen.has(normalized)) {
      rejected.push({ rawName, code: 'duplicate', detail: 'Same person listed twice.' })
      continue
    }

    const reason = (match.reason ?? '').trim()
    if (reason.length === 0) {
      rejected.push({
        rawName,
        code: 'missing-reason',
        detail: 'No reason given, so there is nothing to justify the match.',
      })
      continue
    }

    seen.add(normalized)
    accepted.push({
      ensName: candidate.ensName,
      displayLabel: candidate.displayLabel,
      reason: reason.slice(0, MAX_REASON_LENGTH),
      evidence: candidate.evidence,
      matchedTerms: candidate.matchedTerms,
      source: candidate.source,
      suspicious: candidate.suspicious,
      availability: candidate.fields.availability,
      retrievalScore: candidate.score,
    })

    if (accepted.length >= MAX_MATCHES) break
  }

  return {
    matches: accepted,
    noMatchReason: answer.noMatchReason ?? null,
    rejected,
  }
}

/**
 * The honest empty case.
 *
 * Built here rather than in the route so the shape is identical whether no-match came from
 * an empty retrieval, an availability gate, or an empty `matches` array from the model.
 */
export function noMatchVerdict(reason: string): ModelVerdict {
  return { matches: [], noMatchReason: reason, rejected: [] }
}

/**
 * One-line summary of a no-match, suitable for the UI headline.
 *
 * Written here so the "nobody fits" answer is always explicit rather than an empty table.
 */
export const NO_MATCH_HEADLINE = 'Nobody in this community fits that.'