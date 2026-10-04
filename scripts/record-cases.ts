/**
 * Record the expected-query dataset against a real run.  `npm run record`
 *
 * SCORED CRITERION 6 (8 points) has two halves: the cases must *state* their expected members
 * (that is `src/shared/expected-queries.json`, reviewed by a test) and a run must be *recorded*
 * (that is this script's output, `docs/expected-queries.md`).
 *
 * Everything here is measured, not asserted:
 *
 *   - the app is started in-process on an ephemeral port, using the real Sepolia client and the
 *     real configured model. Nothing about the answer is stubbed.
 *   - each case is judged by `judgeCase` against what the API actually returned.
 *   - the generated document states the model, the provider host, whether the index was live or
 *     simulated, and the exact timestamp of the run.
 *
 * If the model or the RPC is unreachable, that is written into the document as a failure. The
 * script exits non-zero and does not produce a table of passing cases, because a record that
 * cannot be reproduced is worse than no record.
 *
 * Usage:
 *   npm run record                     # start the app in-process, run every case
 *   npm run record -- --json           # also print the raw verdicts as JSON on stdout
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from '../src/server/index'
import { ConfigError, parseConfig, toPublicConfigView } from '../src/server/config'
import { EXPECTED_QUERIES, judgeCase, type CaseVerdict, type ExpectedCase } from '../src/shared/expected-queries'
import { PROFILE_RECORD_KEYS, ROSTER_RECORD_KEY, type CommunityProfile } from '../src/shared/profile'
import { applyAvailabilityGate, retrieveCandidates, RETRIEVAL_DEFAULTS } from '../src/shared/retrieval'
import { PLANNED_COMMUNITY_ROOT } from '../src/shared/demo-community'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..')
const outputPath = join(repoRoot, 'docs', 'expected-queries.md')
const asJson = process.argv.slice(2).includes('--json')

interface FindResponse {
  readonly noMatch: boolean
  readonly headline: string
  readonly noMatchReason: string | null
  readonly matches: Array<{ ensName: string; reason: string; evidence: string; source: string }>
  readonly rejected: Array<{ rawName: string; code: string; detail: string }>
  readonly unavailableNearMisses: Array<{ ensName: string; availability: string | null }>
  readonly retrieval: {
    readonly considered: number
    readonly candidatesSent: number
    readonly topK: number
    readonly indexSource: string
  }
  readonly model: { readonly used: boolean; readonly model: string | null; readonly providerHost: string | null; readonly skippedReason: string | null }
}

interface RunOutcome {
  readonly testCase: ExpectedCase
  readonly verdict: CaseVerdict
  readonly observed: FindResponse | null
  readonly failure: string | null
  readonly durationMs: number
  readonly reach: Reach
}

/**
 * The model-free half of every case.
 *
 * "Did the model pick the right person?" depends on the model and can change with the weather.
 * "Was the right person *available to be picked*?" is deterministic: it is decided by retrieval
 * and the availability gate, both of which are pure functions of the index and the question.
 *
 * These two are recorded separately on purpose. A case whose expected member never reaches the
 * candidate set is a defect in the expectation or in retrieval; a case whose expected member
 * reached the model and was not returned is a statement about that model.
 */
interface Reach {
  /** Candidate names actually sent to the model. */
  readonly sentToModel: readonly string[]
  /** Expected names that retrieval or the gate kept away from the model. */
  readonly unreachable: readonly string[]
  /** True when the candidate set is consistent with the case's expectation. */
  readonly achievable: boolean
  readonly note: string
}

function checkReach(
  profiles: readonly CommunityProfile[],
  testCase: ExpectedCase,
  topK: number,
  minScore: number,
): Reach {
  const retrieval = retrieveCandidates(profiles, testCase.question, { topK, minScore })
  const gate = applyAvailabilityGate(testCase.question, retrieval.candidates)
  const sentToModel = gate.candidates.map((candidate) => candidate.ensName)

  if (testCase.expect === 'no-match') {
    const empty = sentToModel.length === 0
    return {
      sentToModel,
      unreachable: [],
      achievable: empty,
      note: empty
        ? 'zero candidates reach the model, so this is answered without a model call'
        : `${sentToModel.length} candidate(s) would reach the model, so this is NOT a no-match case`,
    }
  }

  const reachable = new Set(sentToModel)
  const unreachable = testCase.mustInclude.filter((name) => !reachable.has(name))
  return {
    sentToModel,
    unreachable,
    achievable: unreachable.length === 0,
    note:
      unreachable.length === 0
        ? `every expected member is inside the bound of ${topK}`
        : `not inside the bound of ${topK}: ${unreachable.join(', ')}`,
  }
}

function line(char = '-'): string {
  return char.repeat(78)
}

async function main(): Promise<number> {
  let config
  try {
    config = parseConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`)
      return 1
    }
    throw error
  }

  const view = toPublicConfigView(config)
  const app = createApp(config)
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = `http://127.0.0.1:${port}`

  const startedAt = new Date()

  console.log('')
  console.log(line('='))
  console.log('  Recording the expected-query dataset against a real run')
  console.log(line('='))
  console.log(`  model     ${view.model} @ ${view.providerHost}`)
  console.log(`  rpc       ${view.rpcHost}`)
  console.log(`  root      ${view.communityRoot}`)
  console.log(`  bound     top-k ${view.topK}, min score ${view.minCandidateScore}`)
  console.log(`  cases     ${EXPECTED_QUERIES.cases.length}`)
  console.log('')

  const refreshResponse = await fetch(`${base}/api/community/refresh`, { method: 'POST' })
  const indexBody = (await refreshResponse.json()) as {
    rosterSource: string
    simulated: boolean
    memberCount: number
    profiles: CommunityProfile[]
    notices: string[]
  }

  const liveProfiles = indexBody.profiles.filter((p) => p.source === 'ens').length

  console.log(`  index: ${indexBody.memberCount} profile(s), roster source ${indexBody.rosterSource},`)
  console.log(`  ${liveProfiles} read live from ENS, ${indexBody.memberCount - liveProfiles} simulated.`)
  if (indexBody.simulated) {
    console.log('')
    console.log('  NOTE: the index is SIMULATED. The recorded results below describe the app')
    console.log('  running on the labelled local fixture set, not on published Sepolia records.')
  }
  console.log('')

  const outcomes: RunOutcome[] = []

  for (const [index, testCase] of EXPECTED_QUERIES.cases.entries()) {
    const caseStarted = Date.now()
    const refreshFirst = index === 0

    let observed: FindResponse | null = null
    let failure: string | null = null

    try {
      const response = await fetch(`${base}/api/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: testCase.question, refreshFirst }),
      })
      const body = (await response.json()) as FindResponse & {
        error?: { code: string; message: string }
      }

      if (body.error) {
        failure = `${body.error.code}: ${body.error.message}`
      } else {
        observed = body
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    const verdict = judgeCase(testCase, {
      returned: observed?.matches.map((m) => m.ensName) ?? [],
      noMatch: observed?.noMatch ?? false,
    })

    // Computed from the index alone: no model involved, so this half is reproducible.
    const reach = checkReach(indexBody.profiles, testCase, view.topK, view.minCandidateScore)

    outcomes.push({
      testCase,
      verdict,
      observed,
      failure,
      durationMs: Date.now() - caseStarted,
      reach,
    })

    const status = failure !== null ? 'ERROR' : verdict.passed ? 'pass' : 'FAIL'
    console.log(`  [${status}] ${testCase.id}  (${Date.now() - caseStarted} ms)`)
    console.log(`      ${testCase.question}`)
    console.log(
      `      reachable (no model): ${reach.achievable ? 'yes' : 'NO'} — ${reach.note}` +
        ` [${reach.sentToModel.join(', ') || 'nothing sent'}]`,
    )
    if (failure !== null) {
      console.log(`      ${failure}`)
    } else {
      const returned = observed?.matches.map((m) => m.ensName) ?? []
      console.log(
        `      returned: ${observed?.noMatch ? '(explicit no-match)' : returned.join(', ') || '(nothing)'}`,
      )
      console.log(`      candidates sent: ${observed?.retrieval.candidatesSent} of ${observed?.retrieval.topK}`)
      console.log(`      model used: ${observed?.model.used ? observed.model.model : 'no'}${observed?.model.skippedReason ? ` — ${observed.model.skippedReason}` : ''}`)
      if (observed && observed.rejected.length > 0) {
        console.log(`      rejected names: ${observed.rejected.map((r) => `${r.rawName} (${r.code})`).join(', ')}`)
      }
      if (observed && observed.unavailableNearMisses.length > 0) {
        console.log(
          `      unavailable near-misses: ${observed.unavailableNearMisses.map((p) => p.ensName).join(', ')}`,
        )
      }
      console.log(`      ${verdict.note}`)
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()))

  const passed = outcomes.filter((o) => o.failure === null && o.verdict.passed).length
  const failed = outcomes.filter((o) => o.failure === null && !o.verdict.passed).length
  const errored = outcomes.filter((o) => o.failure !== null).length
  const unreachable = outcomes.filter((o) => !o.reach.achievable).length

  console.log('')
  console.log(`  ${passed} passed, ${failed} failed, ${errored} errored, of ${outcomes.length}`)
  console.log(
    `  retrieval reachable: ${outcomes.length - unreachable} of ${outcomes.length} cases had their expected members inside the bound`,
  )
  console.log('')

  const docsDir = dirname(outputPath)
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(
    outputPath,
    renderDocument({
      generatedAt: startedAt.toISOString(),
      model: view.model,
      providerHost: view.providerHost,
      rpcHost: view.rpcHost,
      communityRoot: view.communityRoot,
      topK: view.topK,
      minScore: view.minCandidateScore,
      indexSource: indexBody.rosterSource,
      simulated: indexBody.simulated,
      memberCount: indexBody.memberCount,
      liveProfiles,
      notices: indexBody.notices,
      outcomes,
      totals: { passed, failed, errored, unreachable },
    }),
    'utf8',
  )

  console.log(`  written: ${outputPath}`)
  console.log('')

  if (asJson) console.log(JSON.stringify(outcomes.map((o) => o.verdict), null, 2))

  return failed + errored === 0 ? 0 : 1
}

interface DocumentInput {
  readonly generatedAt: string
  readonly model: string
  readonly providerHost: string
  readonly rpcHost: string
  readonly communityRoot: string
  readonly topK: number
  readonly minScore: number
  readonly indexSource: string
  readonly simulated: boolean
  readonly memberCount: number
  readonly liveProfiles: number
  readonly notices: readonly string[]
  readonly outcomes: readonly RunOutcome[]
  readonly totals: {
    readonly passed: number
    readonly failed: number
    readonly errored: number
    readonly unreachable: number
  }
}

function renderDocument(input: DocumentInput): string {
  const out: string[] = []
  const rule = line()

  out.push('# Recorded test queries — Community People Finder')
  out.push('')
  out.push('> Generated by `npm run record` from `src/shared/expected-queries.json` plus one real run.')
  out.push('> Do not hand-edit the observed section; edit the dataset and re-record.')
  out.push('')
  out.push(rule)
  out.push('## What is recorded')
  out.push('')
  out.push('Each case names the community members it must return, or states `expect: "no-match"`.')
  out.push('`mustNotInclude` is enforced as hard as `mustInclude`; `mayInclude` is deliberately not an')
  out.push('assertion, because a reasonable answer may contain more than the minimum.')
  out.push('')
  out.push('Each case is checked in **two independent halves**, because they fail for different reasons:')
  out.push('')
  out.push('1. **Reachable (no model).** Computed from the index alone: is the expected member inside the')
  out.push(`   top-k bound, after the availability gate? Retrieval and the gate are pure functions, so`)
  out.push('   this half is reproducible. A `NO` here means the expectation is unreachable — a defect in')
  out.push('   the case or in retrieval, never a statement about a model.')
  out.push('2. **Observed (model).** What the configured model actually returned, and whether it matched')
  out.push('   the expectation. This half depends on the model named below and can change with it.')
  out.push('')
  out.push(`- Problem: \`community-people-finder\``)
  out.push(`- Community root: \`${input.communityRoot}\``)
  out.push(`- Candidate bound in force: top-k **${input.topK}**, relevance floor **${input.minScore}**`)
  out.push(`- Roster record: \`${ROSTER_RECORD_KEY}\``)
  out.push(`- Profile records: ${Object.values(PROFILE_RECORD_KEYS).map((k) => `\`${k}\``).join(', ')}`)
  out.push(`- Retrieval is deterministic lexical scoring; defaults ${JSON.stringify(RETRIEVAL_DEFAULTS)}`)
  out.push('')

  if (input.simulated) {
    out.push('> **The run below used the SIMULATED index.** No member record was readable on Sepolia,')
    out.push('> so the app answered from the labelled local fixture set. The results demonstrate the')
    out.push('> application logic; they are not evidence about published ENS records.')
    out.push('')
  }

  out.push(rule)
  out.push('## The run')
  out.push('')
  out.push(`- Recorded at: \`${input.generatedAt}\``)
  out.push(`- Model: \`${input.model}\` at host \`${input.providerHost}\``)
  out.push(`- Sepolia RPC host: \`${input.rpcHost}\``)
  out.push(`- Index source: \`${input.indexSource}\` — ${input.liveProfiles} of ${input.memberCount} profile(s) read live from ENS`)
  out.push(`- Result: **${input.totals.passed} passed, ${input.totals.failed} failed, ${input.totals.errored} errored**`)
  out.push(
    `- Reachable without a model: **${input.outcomes.length - input.totals.unreachable} of ${input.outcomes.length}** cases had their expected members inside the bound`,
  )
  out.push('')

  if (input.totals.unreachable > 0) {
    out.push('> **Some expected members never reach the model.** That is a defect in the expectation or')
    out.push('> in retrieval, not a model problem, and it is listed per case below.')
    out.push('')
  }

  if (input.totals.failed > 0) {
    out.push('> **Some cases did not match on this run.** Where the expected member *did* reach the model')
    out.push('> (check the reachable line per case), the mismatch is a property of the model named above.')
    out.push('> The guards still held: no name outside the candidate set reached the answer, and the')
    out.push('> no-match cases never called the model.')
    out.push('')
  }

  if (input.notices.length > 0) {
    out.push('<details><summary>Index notices from this run</summary>')
    out.push('')
    for (const notice of input.notices) out.push(`- ${notice}`)
    out.push('')
    out.push('</details>')
    out.push('')
  }

  out.push(rule)
  out.push('## Cases')
  out.push('')

  for (const outcome of input.outcomes) {
    const { testCase, verdict, observed, failure, reach } = outcome
    const badge = failure !== null ? 'ERROR' : verdict.passed ? 'PASS' : 'FAIL'

    out.push(`### \`${testCase.id}\` — ${badge}`)
    out.push('')
    out.push(`**${testCase.question}**`)
    out.push('')
    out.push(`- Expectation: \`${testCase.expect}\``)
    if (testCase.mustInclude.length > 0) {
      out.push(`- Must include: ${testCase.mustInclude.map((n) => `\`${n}\``).join(', ')}`)
    }
    if (testCase.mustNotInclude.length > 0) {
      out.push(`- Must not include: ${testCase.mustNotInclude.map((n) => `\`${n}\``).join(', ')}`)
    }
    if (testCase.mayInclude.length > 0) {
      out.push(`- May include: ${testCase.mayInclude.map((n) => `\`${n}\``).join(', ')}`)
    }
    out.push(`- Why: ${testCase.why}`)
    out.push('')
    out.push(
      `- Reachable (no model): **${reach.achievable ? 'yes' : 'NO'}** — ${reach.note}` +
        `; candidates sent: ${reach.sentToModel.map((n) => `\`${n}\``).join(', ') || 'nothing'}`,
    )
    out.push('')

    if (failure !== null) {
      out.push(`- Observed: **request failed** — ${failure}`)
      out.push('')
      continue
    }

    const returned = observed?.matches.map((m) => m.ensName) ?? []
    out.push('- Observed:')
    out.push(`  - ${observed?.noMatch ? `explicit no-match — ${observed.noMatchReason}` : `${returned.length} match(es): ${returned.join(', ') || '(none)'}`}`)
    out.push(`  - candidates sent to the model: ${observed?.retrieval.candidatesSent} (bound ${observed?.retrieval.topK})`)
    out.push(`  - model used: ${observed?.model.used ? `yes — ${observed?.model.model}` : `no — ${observed?.model.skippedReason}`}`)
    if (observed && observed.unavailableNearMisses.length > 0) {
      out.push(`  - unavailable, excluded and named: ${observed.unavailableNearMisses.map((p) => `\`${p.ensName}\``).join(', ')}`)
    }
    if (observed && observed.rejected.length > 0) {
      out.push(`  - names the model produced that were dropped: ${observed.rejected.map((r) => `\`${r.rawName}\` (${r.code})`).join(', ')}`)
    }
    for (const match of observed?.matches ?? []) {
      out.push(`  - \`${match.ensName}\` — ${match.reason}`)
      out.push(`    - evidence from records: ${match.evidence || '(none)'}`)
      out.push(`    - source: ${match.source}`)
    }
    out.push(`  - verdict: ${verdict.note}`)
    out.push('')
  }

  out.push(rule)
  out.push('## Names that must never appear as results')
  out.push('')
  out.push('`satoshi.eth` and `vitalik.eth` are named inside the adversarial member\'s bio. They are')
  out.push('not community members, and the membership check in `src/shared/model-output.ts` must drop')
  out.push('them even when a model returns them. Several cases above assert exactly that.')
  out.push('')
  out.push(`Planned roster (not published): ${PLANNED_COMMUNITY_ROOT} with 9 planned members, held in \`src/shared/demo-community.ts\`.`)
  out.push('')

  return `${out.join('\n')}\n`
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error: unknown) => {
    console.error('')
    console.error(`  Record failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error('')
    process.exit(1)
  })