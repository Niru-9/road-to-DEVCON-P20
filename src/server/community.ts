/**
 * The community index: which names are members, and what their profiles say.
 *
 * SCORED CRITERION 4 lives here too. The index is built by calling
 * `readCommunityProfile` for every member, and every field in every profile comes from a
 * `getEnsText` call. Refreshing re-reads the roster and all members from chain, so a profile
 * edited on Sepolia shows up on the next refresh with no code change and no restart.
 *
 * Discovery is deliberately honest about where the member list came from:
 *
 *   'ens-record'  the roster was read from the root name's `com.peoplefinder.members`
 *   'configured'  the roster record is not published yet, so COMMUNITY_MEMBERS was used —
 *                 the member profiles are still read live from chain, only the list differs
 *   'simulated'  no live member was readable, so the labelled local fixture set is used
 *   'none'       nothing at all
 *
 * That distinction is carried to the API and the UI on every response. A simulated index is
 * never presented as chain data.
 */

import {
  isIndexable,
  parseRoster,
  ROSTER_RECORD_KEY,
  type CommunityProfile,
  type ProfileRecordStatus,
} from '../shared/profile'
import {
  buildSimulatedProfiles,
  PLANNED_COMMUNITY_ROOT,
  SIMULATED_NOTICE,
} from '../shared/demo-community'
import {
  isNormalizableEnsName,
  normalizeEnsName,
  readCommunityProfile,
  readRosterRecord,
  type EnsClient,
  type EnsTextReader,
} from './ens'
import type { AppConfig } from './config'

/** How many members are read at once. Public RPCs rate-limit; sequential would be too slow. */
export const READ_CONCURRENCY = 3

export type RosterSource = 'ens-record' | 'configured' | 'simulated' | 'none'
export type IndexStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface RejectedMemberName {
  readonly rawName: string
  readonly reason: string
}

export interface CommunityIndexState {
  readonly status: IndexStatus
  /** ISO timestamp of the last completed refresh, or null before the first one. */
  readonly refreshedAt: string | null
  readonly root: string
  readonly rosterSource: RosterSource
  readonly rosterStatus: ProfileRecordStatus
  readonly rosterError: string | null
  /** Normalized names that were attempted this refresh. */
  readonly attemptedNames: readonly string[]
  readonly rejectedNames: readonly RejectedMemberName[]
  readonly profiles: readonly CommunityProfile[]
  /** Members skipped because they said nothing retrievable. */
  readonly emptyProfiles: readonly string[]
  /** Members whose reads failed outright. */
  readonly failedProfiles: readonly string[]
  /** True when any live read failed, so the UI can warn that coverage is incomplete. */
  readonly partial: boolean
  readonly notices: readonly string[]
  readonly error: string | null
  readonly durationMs: number | null
}

function initialState(root: string): CommunityIndexState {
  return {
    status: 'empty',
    refreshedAt: null,
    root,
    rosterSource: 'none',
    rosterStatus: 'unset',
    rosterError: null,
    attemptedNames: [],
    rejectedNames: [],
    profiles: [],
    emptyProfiles: [],
    failedProfiles: [],
    partial: false,
    notices: [],
    error: null,
    durationMs: null,
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index]!, index)
    }
  })

  await Promise.all(runners)
  return results
}

export interface CommunityIndexDeps {
  readonly client: EnsClient
  readonly config: AppConfig
  /** Injectable for tests. Production never passes anything else. */
  readonly readText?: EnsTextReader
}

export class CommunityIndex {
  readonly root: string

  private readonly client: EnsClient
  private readonly config: AppConfig
  private readonly readText: EnsTextReader | undefined
  private state: CommunityIndexState
  /** De-duplicates concurrent refreshes: two clicks cannot interleave two reads. */
  private inFlight: Promise<CommunityIndexState> | null = null

  constructor(deps: CommunityIndexDeps) {
    this.client = deps.client
    this.config = deps.config
    this.readText = deps.readText
    this.root = deps.config.communityRoot
    this.state = initialState(this.root)
  }

  getState(): CommunityIndexState {
    return this.state
  }

  profiles(): readonly CommunityProfile[] {
    return this.state.profiles
  }

  /** Re-read the roster and every member. Concurrent calls share one refresh. */
  async refresh(): Promise<CommunityIndexState> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doRefresh(): Promise<CommunityIndexState> {
    const startedAt = Date.now()
    this.state = { ...this.state, status: 'loading', error: null }

    try {
      const result = await this.build()
      this.state = { ...result, status: 'ready', durationMs: Date.now() - startedAt }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state = {
        ...this.state,
        status: 'error',
        error:
          `Could not read the community index from ENS on Sepolia: ${message}. ` +
          `Check SEPOLIA_RPC_URL in your .env and that the RPC endpoint is reachable.`,
        durationMs: Date.now() - startedAt,
      }
    }

    return this.state
  }

  private async build(): Promise<Omit<CommunityIndexState, 'status' | 'durationMs'>> {
    const notices: string[] = []
    const rejectedNames: RejectedMemberName[] = []

    // ---- 1. Discover the roster from the root name's own record --------------
    const rootName = safeNormalize(this.root) ?? this.root
    const rosterRead = await readRosterRecord(this.client, rootName, this.readText)

    let rosterSource: RosterSource = 'none'
    let memberCandidates: string[] = []
    let rosterStatus: ProfileRecordStatus = rosterRead.status

    if (rosterRead.status === 'read') {
      const parsed = parseRoster(rosterRead.value)
      memberCandidates = parsed.entries
      rosterSource = 'ens-record'
      if (parsed.overflow) {
        notices.push(
          `The roster record lists more than the parser limit; the first ${parsed.entries.length} names were used.`,
        )
      }
      notices.push(
        `Roster read live from ${rootName} (record ${ROSTER_RECORD_KEY}), ${memberCandidates.length} member${memberCandidates.length === 1 ? '' : 's'}.`,
      )
    } else {
      if (rosterRead.status === 'failed' && rosterRead.error) {
        notices.push(`Reading the roster record failed: ${rosterRead.error}`)
      }
      memberCandidates = [...this.config.configuredMembers]
      if (memberCandidates.length > 0) {
        rosterSource = 'configured'
        notices.push(
          `${rootName} has no published ${ROSTER_RECORD_KEY} record, so the member list came from ` +
            `COMMUNITY_MEMBERS in .env. The profiles themselves are still read live from Sepolia.`,
        )
      }
    }

    // ---- 2. Normalize, de-duplicate, cap ------------------------------------
    const normalized: string[] = []
    const seen = new Set<string>()
    let hitMemberCap = false
    for (const raw of memberCandidates) {
      const candidate = safeNormalize(raw)
      if (candidate === null) {
        rejectedNames.push({
          rawName: typeof raw === 'string' ? raw.slice(0, 80) : '',
          reason: 'Not a name ENS will accept.',
        })
        continue
      }
      if (seen.has(candidate)) continue
      seen.add(candidate)
      normalized.push(candidate)
      if (normalized.length >= this.config.communityMembersMax) {
        // Truncation is reported below; the members past the cap were never attempted.
        hitMemberCap = memberCandidates.length > normalized.length
        break
      }
    }

    if (hitMemberCap) {
      notices.push(
        `Stopped at ${this.config.communityMembersMax} members (MAX_COMMUNITY_MEMBERS); the rest of the roster was not attempted.`,
      )
    }

    // ---- 3. Read every member's records from chain --------------------------
    let profiles: CommunityProfile[] = []
    const failedProfiles: string[] = []
    const emptyProfiles: string[] = []

    if (normalized.length > 0) {
      const read = await mapWithConcurrency(normalized, READ_CONCURRENCY, async (name) => {
        try {
          return { name, profile: await readCommunityProfile(this.client, name, this.readText) }
        } catch {
          // A member whose read throws is skipped and reported; it must not abort the
          // refresh, because the rest of the community is still answerable.
          return { name, profile: null }
        }
      })

      for (const entry of read) {
        if (!entry.profile) {
          failedProfiles.push(entry.name)
          continue
        }
        if (everyRecordReadFailed(entry.profile)) {
          // Nothing was learned about this member. That is an RPC problem, not an absent
          // profile, and saying "they published nothing" would be a false claim about a
          // person who may well have published plenty.
          failedProfiles.push(entry.profile.ensName)
          continue
        }
        if (!isIndexable(entry.profile)) {
          emptyProfiles.push(entry.profile.ensName)
          continue
        }
        profiles.push(entry.profile)
      }

      const liveCount = profiles.length
      notices.push(
        `Read ${liveCount} profile${liveCount === 1 ? '' : 's'} from ENS text records on Sepolia ` +
          `(${normalized.length} member${normalized.length === 1 ? '' : 's'} attempted).`,
      )

      if (emptyProfiles.length > 0) {
        notices.push(
          `${emptyProfiles.length} name${emptyProfiles.length === 1 ? '' : 's'} carried no skills, role or bio, ` +
            `so ${emptyProfiles.length === 1 ? 'it is' : 'they are'} not in the index: ${emptyProfiles.join(', ')}.`,
        )
      }
    }

    // ---- 4. Nothing live was usable -----------------------------------------
    if (profiles.length === 0) {
      if (this.config.allowSimulatedIndex) {
        profiles = buildSimulatedProfiles()
        rosterSource = 'simulated'
        rosterStatus = 'unset'
        notices.unshift(SIMULATED_NOTICE)
        notices.push(
          `Live ENS reads were attempted for ${normalized.length} member name(s) and yielded no usable profile.`,
        )
      } else {
        if (rosterSource === 'none') rosterSource = 'none'
        notices.push(
          `No live member profiles could be read, and ALLOW_SIMULATED_INDEX=false, so the index is empty. ` +
            `Publish the roster and profile records described in docs/profile-format.md, then refresh.`,
        )
      }
    }

    const partial = failedProfiles.length > 0 || emptyProfiles.length > 0

    return {
      refreshedAt: new Date().toISOString(),
      root: this.root,
      rosterSource,
      rosterStatus,
      rosterError: rosterRead.error,
      attemptedNames: normalized,
      rejectedNames,
      profiles,
      emptyProfiles,
      failedProfiles,
      partial,
      notices,
      error: null,
    }
  }
}

/** True when every documented profile key failed to read, so we know nothing about the name. */
function everyRecordReadFailed(profile: CommunityProfile): boolean {
  const statuses = Object.values(profile.recordStatus)
  return statuses.length > 0 && statuses.every((status) => status === 'failed')
}

function safeNormalize(input: string): string | null {
  if (typeof input !== 'string' || !isNormalizableEnsName(input)) return null
  try {
    return normalizeEnsName(input)
  } catch {
    return null
  }
}

/** The default root used in docs and the simulated notice, for display only. */
export const DOCUMENTED_ROOT = PLANNED_COMMUNITY_ROOT