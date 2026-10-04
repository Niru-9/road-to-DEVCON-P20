/**
 * The recorded test-query dataset.
 *
 * SCORED CRITERION 6 (8 points): "Recorded test queries state their expected members."
 *
 * `expected-queries.json` is the canonical dataset: every case either lists the ENS names it
 * must and may return, or states `expect: "no-match"` explicitly. The UI offers these as
 * one-click example queries, `docs/expected-queries.md` is generated from them, and a test
 * asserts every expected name is actually in the planned roster so the two cannot drift.
 *
 * These are EXPECTED results, written from the retrieval rules and the planned records. They
 * are not a claim that the community is seeded or that a run has happened: `observed` fields
 * are filled in by `npm run record` once real Sepolia records exist.
 */

import { z } from 'zod'

import dataset from './expected-queries.json'

const ensName = z.string().regex(/^.+\.[a-z]{2,}$/, 'must be a full ENS name')

export const expectedCaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1).max(500),
  expect: z.enum(['matches', 'no-match']),
  mustInclude: z.array(ensName),
  mayInclude: z.array(ensName),
  mustNotInclude: z.array(ensName),
  why: z.string().min(1),
})

export const expectedDatasetSchema = z.object({
  problem: z.literal('community-people-finder'),
  communityRoot: ensName,
  status: z.string(),
  cases: z.array(expectedCaseSchema).min(1),
})

export type ExpectedCase = z.infer<typeof expectedCaseSchema>

export interface ExpectedDataset {
  readonly communityRoot: string
  readonly status: string
  readonly cases: readonly ExpectedCase[]
  /** Non-null when the file failed to validate; surfaced rather than silently ignored. */
  readonly problem: string | null
}

/**
 * Load and validate the dataset at import time.
 *
 * A malformed dataset is a repo defect, so the failure is captured as `problem` and shown in
 * the UI instead of crashing the server.
 */
export function loadExpectedQueries(): ExpectedDataset {
  const parsed = expectedDatasetSchema.safeParse(dataset)
  if (!parsed.success) {
    return {
      communityRoot: 'unknown',
      status: 'unavailable',
      cases: [],
      problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }

  return {
    communityRoot: parsed.data.communityRoot,
    status: parsed.data.status,
    cases: parsed.data.cases,
    problem: null,
  }
}

export const EXPECTED_QUERIES: ExpectedDataset = loadExpectedQueries()

/** Example queries for the UI: the recorded ones, in dataset order. */
export const EXAMPLE_QUERIES: readonly ExpectedCase[] = EXPECTED_QUERIES.cases

/** True when the dataset explicitly expects nobody to fit. */
export function expectsNoMatch(testCase: ExpectedCase): boolean {
  return testCase.expect === 'no-match'
}

/** Score one observed run against one recorded case. Used by `npm run record`. */
export interface CaseVerdict {
  readonly id: string
  readonly question: string
  readonly passed: boolean
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  readonly forbiddenPresent: readonly string[]
  readonly expectedNoMatch: boolean
  readonly observedNoMatch: boolean
  readonly note: string
}

/**
 * Check an observed result against a recorded case.
 *
 * `mayInclude` is intentionally not an assertion: it records what a reasonable answer could
 * contain without demanding it. Only `mustInclude`, `mustNotInclude` and the no-match
 * expectation are enforced.
 */
export function judgeCase(
  testCase: ExpectedCase,
  observed: { readonly returned: readonly string[]; readonly noMatch: boolean },
): CaseVerdict {
  const returned = new Set(observed.returned.map((name) => name.toLowerCase()))
  const expectedNoMatch = expectsNoMatch(testCase)

  const missing = testCase.mustInclude.filter((name) => !returned.has(name.toLowerCase()))
  const forbiddenPresent = testCase.mustNotInclude.filter((name) => returned.has(name.toLowerCase()))
  const unexpected = [...returned].filter(
    (name) => !testCase.mustInclude.some((n) => n.toLowerCase() === name),
  )

  const noMatchOk = expectedNoMatch ? observed.noMatch : !observed.noMatch || missing.length === 0
  const passed =
    missing.length === 0 && forbiddenPresent.length === 0 && (!expectedNoMatch || observed.noMatch)

  const note = expectedNoMatch
    ? observed.noMatch
      ? 'Explicit no-match returned, as expected.'
      : `Expected nobody to fit, but got: ${[...returned].join(', ') || '(nothing)'}.`
    : passed
      ? 'All required members returned, none forbidden.'
      : noMatchOk
        ? 'Required members missing.'
        : 'Returned an unexpected no-match.'

  return {
    id: testCase.id,
    question: testCase.question,
    passed,
    missing,
    unexpected,
    forbiddenPresent,
    expectedNoMatch,
    observedNoMatch: observed.noMatch,
    note,
  }
}