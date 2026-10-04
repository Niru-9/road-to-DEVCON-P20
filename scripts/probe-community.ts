/**
 * Read-only Sepolia probe.  `npm run probe:community`
 *
 * Answers one question with evidence: **what does ENS on Sepolia actually say right now?**
 *
 * This script only ever reads. It builds no transaction, signs nothing, and has no wallet. Every
 * value it prints came from an `eth_call` through the Universal Resolver, or from the labelled
 * simulated fixture set when no live member could be read — and which of those happened is
 * printed on every run.
 *
 * Usage:
 *   npm run probe:community                 # roster + every member, live
 *   npm run probe:community -- --retrieval  # also print the candidate set per recorded case
 *
 * The retrieval pass is deliberately model-free: it shows what *would* be sent to the model, so
 * a reviewer can check the candidate bound and the availability gate without spending an API
 * call or needing a provider at all.
 */

import { ConfigError, parseConfig, toPublicConfigView } from '../src/server/config'
import { CommunityIndex } from '../src/server/community'
import { createEnsClient } from '../src/server/ens'
import { EXPECTED_QUERIES } from '../src/shared/expected-queries'
import { applyAvailabilityGate, retrieveCandidates } from '../src/shared/retrieval'
import { PROFILE_RECORD_KEYS, ROSTER_RECORD_KEY } from '../src/shared/profile'
import { KNOWN_NON_MEMBERS } from '../src/shared/demo-community'

const wantRetrieval = process.argv.slice(2).includes('--retrieval')

function line(char = '-'): string {
  return char.repeat(72)
}

function field(value: string | null, max = 58): string {
  if (value === null || value === '') return '(unset)'
  const single = value.replace(/\s+/g, ' ')
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

async function main(): Promise<void> {
  let config
  try {
    config = parseConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  const view = toPublicConfigView(config)

  console.log('')
  console.log(line('='))
  console.log('  Community People Finder — read-only Sepolia probe')
  console.log(line('='))
  console.log(`  RPC            ${view.rpcHost} (chain sepolia, 11155111)`)
  console.log(`  Community root ${view.communityRoot}`)
  console.log(`  Roster record  ${ROSTER_RECORD_KEY}`)
  console.log(`  Profile keys   ${Object.values(PROFILE_RECORD_KEYS).join(', ')}`)
  console.log(`  Member cap     ${view.maxMembers}`)
  console.log(`  Top-k / floor  ${view.topK} candidates, min score ${view.minCandidateScore}`)
  console.log('')
  console.log('  READ ONLY: no transaction is built, nothing is signed, no wallet is used.')
  console.log(line())

  const client = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
  const index = new CommunityIndex({ client, config })
  const startedAt = Date.now()
  const state = await index.refresh()

  console.log('')
  console.log(`  Roster source    ${state.rosterSource}`)
  console.log(`  Roster status    ${state.rosterStatus}`)
  if (state.rosterError) console.log(`  Roster error     ${state.rosterError}`)
  console.log(`  Members indexed  ${state.profiles.length}`)
  console.log(`  Partial          ${state.partial}`)
  console.log(`  Duration         ${state.durationMs ?? Date.now() - startedAt} ms`)
  if (state.refreshedAt) console.log(`  Refreshed at     ${state.refreshedAt}`)

  if (state.notices.length > 0) {
    console.log('')
    console.log('  Notices')
    for (const notice of state.notices) {
      for (const part of notice.match(/.{1,68}(\s|$)/g) ?? [notice]) {
        console.log(`    ${part.trim()}`)
      }
    }
  }

  if (state.rejectedNames.length > 0) {
    console.log('')
    console.log('  Roster entries rejected')
    for (const rejected of state.rejectedNames) {
      console.log(`    ${field(rejected.rawName, 40)} — ${rejected.reason}`)
    }
  }

  if (state.failedProfiles.length > 0) {
    console.log('')
    console.log('  Member reads that failed (unknown, NOT "published nothing")')
    for (const name of state.failedProfiles) console.log(`    ${name}`)
  }

  if (state.emptyProfiles.length > 0) {
    console.log('')
    console.log('  Members with nothing retrievable (no skills, role or bio)')
    for (const name of state.emptyProfiles) console.log(`    ${name}`)
  }

  console.log('')
  console.log(line())
  console.log(`  Profiles (${state.profiles.length})`)
  console.log(line())

  if (state.profiles.length === 0) {
    console.log('  (none)')
  }

  for (const profile of state.profiles) {
    const { fields, recordStatus, warnings, suspicious, source } = profile
    const flags: string[] = []
    if (suspicious) flags.push('SUSPICIOUS: instruction-like text, shown as data, never obeyed')
    if (source === 'simulated') flags.push('SIMULATED: not read from chain')
    if (profile.address === null) flags.push('no address (text records only)')

    console.log('')
    console.log(`  ${profile.ensName}`)
    console.log(`    displayName   [${recordStatus.displayName}] ${field(fields.displayName)}`)
    console.log(`    role          [${recordStatus.role}] ${field(fields.role)}`)
    console.log(`    skills        [${recordStatus.skills}] ${field(fields.skills.join(', '))}`)
    console.log(`    availability  [${recordStatus.availability}] ${fields.availability ?? '(unset — treated as unknown)'}`)
    console.log(`    bio           [${recordStatus.bio}] ${field(fields.bio, 58)}`)

    if (flags.length > 0) {
      for (const flag of flags) console.log(`    ! ${flag}`)
    }

    for (const warning of warnings) {
      console.log(`    ! warning ${warning.code} (${warning.field}): ${field(warning.detail, 46)}`)
    }
  }

  // ---------------------------------------------------------------------
  // What this probe does and does not prove
  // ---------------------------------------------------------------------
  console.log('')
  console.log(line('='))
  console.log('  What this run establishes')
  console.log(line('='))
  if (state.rosterSource === 'ens-record' && state.profiles.some((p) => p.source === 'ens')) {
    console.log(`  The roster and ${state.profiles.filter((p) => p.source === 'ens').length} profile(s) were read live from`)
    console.log('  Sepolia text records through the Universal Resolver.')
  } else if (state.rosterSource === 'configured') {
    console.log('  The roster record is NOT published, so the member list came from COMMUNITY_MEMBERS.')
    console.log('  The profiles above were still read live from Sepolia.')
  } else if (state.rosterSource === 'simulated') {
    console.log('  NO live member profile could be read. Everything above is the LOCAL SIMULATED')
    console.log('  fixture set. It is not chain data and must never be presented as such.')
  } else {
    console.log('  Nothing was indexed: no roster, no configured members, no simulated fallback.')
  }

  console.log('')
  console.log('  Known non-members that must never appear as results:')
  console.log(`    ${KNOWN_NON_MEMBERS.join(', ')}`)

  if (wantRetrieval) {
    console.log('')
    console.log(line('='))
    console.log('  Retrieval dry run — no model call, candidates only')
    console.log(line('='))

    const profiles = index.profiles()
    const cases = EXPECTED_QUERIES.cases

    for (const testCase of cases) {
      const retrieval = retrieveCandidates(profiles, testCase.question, {
        topK: config.topK,
        minScore: config.minCandidateScore,
      })
      const gate = applyAvailabilityGate(testCase.question, retrieval.candidates)

      console.log('')
      console.log(`  [${testCase.id}] ${testCase.question}`)
      console.log(`    expect: ${testCase.expect}`)
      console.log(
        `    considered ${retrieval.considered} | above floor ${retrieval.aboveThreshold} | ` +
          `sent ${gate.candidates.length} (bound ${retrieval.topK})`,
      )

      for (const candidate of gate.candidates) {
        console.log(
          `      + ${candidate.ensName}  score ${candidate.score}  via ${candidate.matchedTerms.join(', ')}`,
        )
      }
      for (const excluded of gate.excludedUnavailable) {
        console.log(`      - ${excluded.ensName}  EXCLUDED: marked unavailable, never sent to the model`)
      }
      if (gate.candidates.length === 0) {
        console.log('      (no candidates — this question answers as an explicit no-match)')
      }
    }

    console.log('')
    console.log('  Recorded expectations are declared, not verified: nothing above called a model.')
    console.log('  Run `npm run record` against a live server to judge them for real.')
  }

  console.log('')
}

main().catch((error: unknown) => {
  console.error('')
  console.error(`  Probe failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error('')
  process.exit(1)
})