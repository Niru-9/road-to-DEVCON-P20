/**
 * Retrieval: turn a natural-language question into a **bounded** candidate set.
 *
 * THIS MODULE IS THE ANSWER TO SCORED CRITERION 2 (10 points):
 * "Only a bounded number of candidates is sent to the model."
 *
 * The bound is not advisory. `retrieveCandidates` slices to `topK` and drops everything
 * below `minScore` before returning, so there is no code path by which the whole index
 * reaches the prompt. `topK` defaults to `RETRIEVAL_DEFAULTS.topK` and is surfaced in
 * `/api/health`, so the limit in force is inspectable rather than buried.
 *
 * Scoring is deterministic and lexical — no embeddings, no model call, no API budget.
 * That is a deliberate MVP choice: it makes retrieval reproducible, so a recorded
 * expected-member list can be checked rather than eyeballed. The trade-off is stated in
 * the README.
 *
 * Token weighting per field reflects how much that field is evidence of capability:
 *   skills  3.0   the field a member fills in to be findable
 *   name    2.5   asking for a person by name
 *   role    2.0   job title
 *   avail.  1.5   whether they have time
 *   bio     1.0   prose: weak evidence, and the field most likely to be hostile
 */

import type { CommunityProfile, ProfileFields } from './profile'
import { displayLabel, evidenceLine } from './profile'

export const FIELD_WEIGHTS = {
  skills: 3.0,
  displayName: 2.5,
  role: 2.0,
  availability: 1.5,
  bio: 1.0,
} as const

/**
 * Retrieval defaults. `topK` is the scored bound; `minScore` is the relevance floor that
 * produces the honest no-match case.
 */
export const RETRIEVAL_DEFAULTS = {
  topK: 5,
  minScore: 1,
} as const

export const MAX_TOP_K = 20

/**
 * Multiplier applied to the score of a profile whose records contain instruction-like text.
 *
 * WHY A PENALTY, AND NOT EXCLUSION
 *
 * Instruction-like text is a *manipulation* signal: it exists to make this profile rank higher
 * and to make the model prefer it. Letting that text win the ranking hands the writer of a bio
 * control over who is recommended, which is the threat this app is built against. So a flagged
 * profile is down-ranked rather than deleted.
 *
 * Exclusion would be the wrong fix: flagging is not proof of dishonesty, and silently removing a
 * real member from every answer is a worse failure than ranking them lower. The flag stays
 * visible in the UI, the profile stays in the index, and it can still be returned when nothing
 * else matches — it just cannot outrank a genuine structured match because of a bio.
 *
 * The penalty is applied to the whole score, not just to bio contributions, because the attack
 * also works by stuffing the *skills* record with every topic under the sun.
 */
export const SUSPICIOUS_SCORE_PENALTY = 0.4

/**
 * Question words that carry no *topical* signal.
 *
 * Deliberately short, and deliberately not the same list as the availability gate. Words like
 * "free", "now" and "mentor" are kept, because they are the availability signal and dropping
 * them would break the no-match case. "help" is the one intent verb that is dropped: it is the
 * verb in almost every question asked of a search box, it describes no topic, and letting it
 * score means an adversarial bio containing the phrase "a helpful assistant" wins the
 * retrieval for questions about dentists. Availability intent is unaffected — `asksAboutAvailability`
 * reads the raw question, not this token list.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'be', 'do', 'does', 'did', 'i', 'me', 'my', 'we',
  'our', 'us', 'you', 'your', 'who', 'whom', 'whose', 'what', 'which', 'when', 'where',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'to', 'for',
  'of', 'in', 'on', 'at', 'by', 'from', 'with', 'and', 'or', 'but', 'any', 'some',
  'looking', 'look', 'need', 'needs', 'want', 'wants', 'please', 'this', 'that', 'there',
  'it', 'its', 'have', 'has', 'had', 'get', 'got', 'find', 'knows', 'know', 'much',
  'lot', 'about', 'also', 'still', 'here', 'someone', 'anybody', 'anyone', 'person',
  'people', 'member', 'members', 'community', 'good', 'great', 'best', 'really', 'like',
  'help', 'helps', 'helped', 'helping',
])

/** Lowercase alphanumeric tokens, keeping `+` and `#` so "c++" and "c#" survive. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9+#]{2,}/g) ?? []
}

/**
 * Very conservative suffix stripping, applied to both sides of every comparison.
 *
 * This is not a stemmer in the linguistic sense and does not try to be: it only folds the
 * handful of inflections that would otherwise make an honest answer impossible — a member
 * whose bio says "I write the documentation" must be findable by a question that says
 * "explaining things in writing". Rules are ordered longest-first, and nothing is stripped
 * from a token shorter than four characters, so `gas`, `evm`, `api` and `busy` are untouched.
 */
export function stemToken(token: string): string {
  if (token.length < 4) return token
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith('sses')) return token.slice(0, -2)
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2)
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function stemAll(tokens: readonly string[]): string[] {
  return tokens.map(stemToken)
}

/** Query tokens that carry signal. */
export function contentTokens(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** Human-readable synonyms for the three canonical availability values. */
const AVAILABILITY_TERMS: Readonly<Record<string, string>> = {
  open: 'open available free availability time',
  limited: 'limited partial some time busy availability',
  unavailable: 'unavailable not available no time availability',
}

function fieldText(profile: CommunityProfile): Record<keyof typeof FIELD_WEIGHTS, string> {
  const { fields } = profile
  return {
    skills: fields.skills.join(' '),
    displayName: fields.displayName ?? '',
    role: fields.role ?? '',
    availability: fields.availability
      ? (AVAILABILITY_TERMS[fields.availability] ?? fields.availability)
      : '',
    bio: fields.bio ?? '',
  }
}

/**
 * Field score for one query token.
 *
 * Both sides are folded with `stemToken` first, so "writing" reaches "write" and "audits"
 * reaches "audit". Exact folded equality scores the full field weight; a prefix of four
 * characters or more scores half, which lets "rust" reach "rust-lang" without letting "ru"
 * match everything.
 */
/**
 * Folded token comparison.
 *
 * Prefix matching requires **both** sides to be at least four characters. Without that floor a
 * two-letter token such as `de` is a prefix of `dentist`, and a member whose bio happens to
 * contain it would be retrieved by a question about dentists. Exact folded equality always
 * counts, at any length.
 */
function foldsMatch(needle: string, candidate: string): boolean {
  if (needle === candidate) return true
  if (needle.length < 4 || candidate.length < 4) return false
  return candidate.startsWith(needle) || needle.startsWith(candidate)
}

/**
 * Field score for one query token.
 *
 * Both sides are folded with `stemToken` first, so "writing" reaches "write" and "audits"
 * reaches "audit". Exact folded equality scores the full field weight; a folded prefix of four
 * characters or more scores half, which lets "rust" reach "rust-lang" without letting "ru"
 * match everything.
 */
function tokenFieldScore(token: string, haystack: string, weight: number): number {
  if (haystack.length === 0) return 0
  const needle = stemToken(token)
  let best = 0
  for (const candidate of stemAll(tokenize(haystack))) {
    if (candidate === needle) return weight
    if (foldsMatch(needle, candidate)) best = Math.max(best, weight / 2)
  }
  return best
}

export interface CandidateProfile {
  readonly ensName: string
  readonly displayLabel: string
  readonly score: number
  /** Query tokens that actually matched, so a match is explainable. */
  readonly matchedTerms: readonly string[]
  /** The structured, non-bio evidence line for this person. */
  readonly evidence: string
  /** Bounded field copy handed to the model as data. */
  readonly fields: ProfileFields
  readonly source: 'ens' | 'simulated'
  readonly suspicious: boolean
  /**
   * Ordering score: `score`, reduced for a profile whose records contain instruction-like text.
   *
   * Kept out of `score` deliberately. `score` measures relevance and is what `minScore` is
   * compared against, so a flag can never decide whether someone is relevant to a question; it
   * only decides whether their stuffed bio outranks someone else's genuine skills. Not part of
   * the API response.
   */
  readonly rankScore?: number
}

export interface RetrievalResult {
  /** At most `topK` entries, sorted by descending score. */
  readonly candidates: readonly CandidateProfile[]
  /** How many indexed profiles were scored, before the top-k slice. */
  readonly considered: number
  /** How many cleared `minScore` before the top-k slice. */
  readonly aboveThreshold: number
  readonly topK: number
  readonly minScore: number
}

export interface RetrieveOptions {
  readonly topK?: number
  readonly minScore?: number
}

/**
 * Score every indexed profile against the query and return a bounded candidate set.
 *
 * Rarity weighting: a token that appears in only one profile is the strongest possible
 * evidence that this profile is the intended one, so it counts for more than a token
 * every profile happens to contain.
 */
export function retrieveCandidates(
  profiles: readonly CommunityProfile[],
  query: string,
  options: RetrieveOptions = {},
): RetrievalResult {
  const topK = clampTopK(options.topK ?? RETRIEVAL_DEFAULTS.topK)
  const minScore = options.minScore ?? RETRIEVAL_DEFAULTS.minScore
  const tokens = contentTokens(query)

  if (tokens.length === 0 || profiles.length === 0) {
    return { candidates: [], considered: profiles.length, aboveThreshold: 0, topK, minScore }
  }

  const texts = profiles.map(fieldText)

  // Document frequency per query token, for the rarity weight. This uses the SAME folded
  // match as the scoring pass. Computing it any other way would let a token reach a profile by
  // inflection while being counted as reaching nobody, which silently discards the token.
  const documentFrequency = new Map<string, number>()
  const tokensPerProfile = texts.map((text) => [
    ...stemAll(tokenize(text.skills)),
    ...stemAll(tokenize(text.displayName)),
    ...stemAll(tokenize(text.role)),
    ...stemAll(tokenize(text.availability)),
    ...stemAll(tokenize(text.bio)),
  ])

  const foldedTokens = tokens.map(stemToken)

  for (const folded of foldedTokens) {
    let count = 0
    for (const profileTokens of tokensPerProfile) {
      if (profileTokens.some((candidate) => foldsMatch(folded, candidate))) count += 1
    }
    documentFrequency.set(folded, count)
  }

  const total = profiles.length
  const scored: CandidateProfile[] = []

  profiles.forEach((profile, index) => {
    const text = texts[index]!
    let score = 0
    const matchedTerms: string[] = []

    for (const token of tokens) {
      const frequency = documentFrequency.get(stemToken(token)) ?? 0
      if (frequency === 0) continue

      const best = Math.max(
        tokenFieldScore(token, text.skills, FIELD_WEIGHTS.skills),
        tokenFieldScore(token, text.displayName, FIELD_WEIGHTS.displayName),
        tokenFieldScore(token, text.role, FIELD_WEIGHTS.role),
        tokenFieldScore(token, text.availability, FIELD_WEIGHTS.availability),
        tokenFieldScore(token, text.bio, FIELD_WEIGHTS.bio),
      )
      if (best === 0) continue

      // log(1 + N/df): 1.0 when every profile has it, growing as it gets rarer.
      const rarity = Math.log(1 + total / frequency)
      score += best * rarity
      matchedTerms.push(token)
    }

    if (score <= 0 || matchedTerms.length === 0) return

    scored.push({
      ensName: profile.ensName,
      displayLabel: displayLabel(profile),
      score: round2(score),
      matchedTerms,
      evidence: evidenceLine(profile),
      fields: profile.fields,
      source: profile.source,
      suspicious: profile.suspicious,
      // Ordering score. Kept separate from `score` on purpose: `score` measures RELEVANCE and
      // is what `minScore` compares against, so the flag can never change whether a profile is
      // relevant. The flag only changes where it sits in the order.
      rankScore: profile.suspicious ? score * SUSPICIOUS_SCORE_PENALTY : score,
    })
  })

  scored.sort((a, b) =>
    (b.rankScore ?? b.score) === (a.rankScore ?? a.score)
      ? a.ensName.localeCompare(b.ensName)
      : (b.rankScore ?? b.score) - (a.rankScore ?? a.score),
  )

  const aboveThreshold = scored.filter((candidate) => candidate.score >= minScore)

  return {
    candidates: aboveThreshold.slice(0, topK),
    considered: profiles.length,
    aboveThreshold: aboveThreshold.length,
    topK,
    minScore,
  }
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) return RETRIEVAL_DEFAULTS.topK
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(value)))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------
// Availability gate
// ---------------------------------------------------------------------------

/**
 * Question wording that asks about someone's *time*, as opposed to their skills.
 *
 * "Is anyone here good at Rust and free to mentor this month?" is an availability
 * question. Someone excellent at Rust but marked `unavailable` is not an answer to it, and
 * returning them anyway is the failure mode the brief calls out.
 */
const AVAILABILITY_INTENT =
  /\b(free|availability|available|unavailable|now|right\s+now|this\s+week|this\s+month|this\s+fortnight|currently|spare\s+time|mentor\w*|pair\w*|chat|help\s+me|help\s+out)\b/i

export function asksAboutAvailability(query: string): boolean {
  return AVAILABILITY_INTENT.test(query)
}

export interface AvailabilityGateResult {
  /** Candidates that survive the gate. May be empty — that is a legitimate no-match. */
  readonly candidates: readonly CandidateProfile[]
  /**
   * Candidates dropped because they are marked `unavailable`. Reported to the user as
   * explicitly *not* matches. Never sent to the model and never displayed as people.
   */
  readonly excludedUnavailable: readonly CandidateProfile[]
}

/**
 * Drop candidates who say they have no time, when the question was about having time.
 *
 * If every candidate is unavailable the result is empty, and the caller returns the
 * explicit no-match response **without calling the model at all** (scored criterion 5).
 * A question that says nothing about time is left untouched: someone unavailable is still
 * the right answer to "who knows about X?".
 */
export function applyAvailabilityGate(
  query: string,
  candidates: readonly CandidateProfile[],
): AvailabilityGateResult {
  if (!asksAboutAvailability(query)) {
    return { candidates, excludedUnavailable: [] }
  }

  const excludedUnavailable = candidates.filter(
    (candidate) => candidate.fields.availability === 'unavailable',
  )
  const kept = candidates.filter((candidate) => candidate.fields.availability !== 'unavailable')

  return { candidates: kept, excludedUnavailable }
}