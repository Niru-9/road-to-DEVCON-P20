/**
 * The find-people flow, kept out of the HTTP layer so it can be tested directly.
 *
 * The order of operations is the whole point of this problem:
 *
 *   1. Retrieve from the live ENS index with an explicit top-k bound.        [criterion 2]
 *   2. Apply the availability gate. If nothing survives, STOP HERE and return an
 *      explicit no-match. The model is never called.                          [criterion 5]
 *   3. Send only the bounded candidates, as data, to a configured endpoint.   [criterion 3, 7]
 *   4. Parse the structured answer, then membership-check every name against the
 *      retrieved candidates before anything is displayed.                    [criterion 1]
 */

import {
  applyAvailabilityGate,
  retrieveCandidates,
  type CandidateProfile,
  type RetrievalResult,
} from '../shared/retrieval'
import {
  enforceCandidateMembership,
  ModelOutputError,
  noMatchVerdict,
  NO_MATCH_HEADLINE,
  parseModelAnswer,
  type MatchedPerson,
  type RejectedName,
} from '../shared/model-output'
import { normalizeEnsName } from './ens'
import { askModel } from './llm'
import type { AppConfig } from './config'
import type { CommunityIndex } from './community'

export interface FindPeopleParams {
  readonly question: string
  readonly index: CommunityIndex
  readonly config: AppConfig
  /** Injectable for tests. Production always uses the real provider call. */
  readonly ask?: typeof askModel
}

export interface CandidateSummary {
  readonly ensName: string
  readonly displayLabel: string
  readonly score: number
  readonly matchedTerms: readonly string[]
  readonly availability: string | null
}

export interface ModelTrace {
  readonly used: boolean
  /** Why the model was not called, when it was not. */
  readonly skippedReason: string | null
  readonly model: string | null
  readonly providerHost: string | null
  readonly durationMs: number | null
  readonly attempts: number | null
  /** The exact messages sent, for the UI evidence panel. */
  readonly messages: ReadonlyArray<{ role: string; content: string }> | null
  /** Set when the model's raw output could not be parsed. */
  readonly rawOutput: string | null
}

export interface FindPeopleResult {
  readonly question: string
  readonly noMatch: boolean
  readonly headline: string
  readonly noMatchReason: string | null
  readonly matches: readonly MatchedPerson[]
  /** Names the model produced that were not shown, and why. */
  readonly rejected: readonly RejectedName[]
  /** Retrieved but excluded because they are marked unavailable. Explicitly NOT matches. */
  readonly unavailableNearMisses: readonly CandidateSummary[]
  readonly retrieval: {
    readonly considered: number
    readonly aboveThreshold: number
    readonly topK: number
    readonly minScore: number
    readonly candidatesSent: number
    readonly candidates: readonly CandidateSummary[]
    readonly indexRefreshedAt: string | null
    readonly indexSource: string
  }
  readonly model: ModelTrace
}

function summarize(candidates: readonly CandidateProfile[]): CandidateSummary[] {
  return candidates.map((candidate) => ({
    ensName: candidate.ensName,
    displayLabel: candidate.displayLabel,
    score: candidate.score,
    matchedTerms: candidate.matchedTerms,
    availability: candidate.fields.availability,
  }))
}

function unusedModel(trace: Partial<ModelTrace> & { used: boolean; skippedReason: string }): ModelTrace {
  return {
    used: trace.used,
    skippedReason: trace.skippedReason,
    model: null,
    providerHost: null,
    durationMs: null,
    attempts: null,
    messages: null,
    rawOutput: null,
  }
}

/**
 * Answer one question.
 *
 * Throws only for genuine failures (provider down, timeout, unparseable output). The
 * no-match case is a normal successful result, not an error: the caller renders it as an
 * answer.
 */
export async function findPeople(params: FindPeopleParams): Promise<FindPeopleResult> {
  const { question, index, config } = params
  const ask = params.ask ?? askModel
  const state = index.getState()

  // --- 1. Retrieval, explicitly bounded ------------------------------------
  const retrieval: RetrievalResult = retrieveCandidates(index.profiles(), question, {
    topK: config.topK,
    minScore: config.minCandidateScore,
  })

  // --- 2. Availability gate --------------------------------------------------
  const gate = applyAvailabilityGate(question, retrieval.candidates)

  const retrievalSummary = {
    considered: retrieval.considered,
    aboveThreshold: retrieval.aboveThreshold,
    topK: retrieval.topK,
    minScore: retrieval.minScore,
    indexRefreshedAt: state.refreshedAt,
    indexSource: state.rosterSource,
  }

  // --- 3. EXPLICIT NO-MATCH, with no model call ------------------------------
  if (gate.candidates.length === 0) {
    const allUnavailable = gate.excludedUnavailable.length > 0
    const reason = allUnavailable
      ? buildUnavailableReason(question, gate.excludedUnavailable)
      : state.profiles.length === 0
        ? 'The community index is empty, so there is nobody to search. Refresh the index first.'
        : 'Nobody in the community index matches that, so there is no one to recommend.'

    return {
      question,
      noMatch: true,
      headline: NO_MATCH_HEADLINE,
      noMatchReason: reason,
      matches: [],
      rejected: [],
      unavailableNearMisses: summarize(gate.excludedUnavailable),
      retrieval: {
        ...retrievalSummary,
        candidatesSent: 0,
        candidates: summarize(retrieval.candidates),
      },
      model: unusedModel({
        used: false,
        skippedReason: allUnavailable
          ? 'Every retrieved candidate was marked unavailable, so no model request was made.'
          : 'Retrieval returned no candidates, so no model request was made.',
      }),
    }
  }

  // --- 4. Model call, bounded candidates only -------------------------------
  const answer = await ask({ question, candidates: gate.candidates, config })

  const modelTrace: ModelTrace = {
    used: true,
    skippedReason: null,
    model: answer.model,
    providerHost: answer.providerHost,
    durationMs: answer.durationMs,
    attempts: answer.attempts,
    messages: answer.messages,
    rawOutput: answer.content.slice(0, 2000),
  }

  // --- 5. Parse, then MEMBERSHIP-CHECK before display ------------------------
  const parsed = parseModelAnswer(answer.content)
  const verdict = enforceCandidateMembership(parsed, gate.candidates, { normalize: normalizeEnsName })

  if (verdict.matches.length === 0) {
    return {
      question,
      noMatch: true,
      headline: NO_MATCH_HEADLINE,
      noMatchReason:
        verdict.noMatchReason ??
        'The model did not pick anyone from the candidates retrieved for this question.',
      matches: [],
      rejected: verdict.rejected,
      unavailableNearMisses: summarize(gate.excludedUnavailable),
      retrieval: {
        ...retrievalSummary,
        candidatesSent: gate.candidates.length,
        candidates: summarize(gate.candidates),
      },
      model: modelTrace,
    }
  }

  return {
    question,
    noMatch: false,
    headline: 'Here is who in this community fits.',
    noMatchReason: null,
    matches: verdict.matches,
    rejected: verdict.rejected,
    unavailableNearMisses: summarize(gate.excludedUnavailable),
    retrieval: {
      ...retrievalSummary,
      candidatesSent: gate.candidates.length,
      candidates: summarize(gate.candidates),
    },
    model: modelTrace,
  }
}

/**
 * The honest version of "nobody fits".
 *
 * Names the people who *would* have matched on skill but are marked unavailable, so the user
 * can see the app understood the question rather than failing to parse it. These are labelled
 * as excluded, are never returned as matches, and were never sent to the model.
 */
function buildUnavailableReason(
  question: string,
  excluded: readonly CandidateProfile[],
): string {
  const names = excluded.map((candidate) => candidate.ensName).join(', ')
  return (
    `${excluded.length === 1 ? 'One member matches' : `${excluded.length} members match`} the topic ` +
    `but ${excluded.length === 1 ? 'is' : 'are'} marked unavailable, and you asked whether anyone has ` +
    `time. Not recommending anyone. ${names} would match on skills alone.`
  )
}

export { ModelOutputError }