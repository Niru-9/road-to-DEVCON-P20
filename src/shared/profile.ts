/**
 * The community ENS profile record format, and every rule that bounds it.
 *
 * WHY THIS FILE EXISTS
 *
 * ENS text records are **public, owner-controlled text**. Anyone can put anything in
 * their own bio, including text written to hijack a language model. So a record read
 * from chain is treated here as *untrusted input at a trust boundary*, not as data we
 * wrote. Three things follow, and all three are implemented below:
 *
 *   1. **Bounded.** No field can grow without limit. Length caps, token caps and a
 *      roster ceiling mean one member cannot flood a prompt or a request.
 *   2. **Sanitised.** Control characters, zero-width characters and bidirectional
 *      overrides are stripped before anything downstream sees the text. Those
 *      characters carry no meaning for a human reader but can hide instructions from a
 *      reader that only sees one direction of the string.
 *   3. **Validated, not trusted.** `availability` is a closed allowlist. Skills are a
 *      bounded token list. Nothing is "executed": the values only ever become text in a
 *      data message that the model is told to treat as data (see `prompt.ts`).
 *
 * Record keys follow ENSIP-5: two standard global keys plus service keys under a
 * namespaced prefix. See `docs/profile-format.md`.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Record keys (ENSIP-5)
// ---------------------------------------------------------------------------

export type ProfileField = 'displayName' | 'role' | 'skills' | 'availability' | 'bio'

/**
 * The documented record keys.
 *
 * `name` and `description` are standard ENSIP-5 *global* keys, so they render in any
 * ENS-aware wallet. Everything we invented lives under `com.peoplefinder.*`, which is
 * the ENSIP-5 convention for your own record format and cannot collide with someone
 * else's namespace.
 */
export const PROFILE_RECORD_KEYS: Readonly<Record<ProfileField, string>> = {
  displayName: 'name',
  role: 'com.peoplefinder.role',
  skills: 'com.peoplefinder.skills',
  availability: 'com.peoplefinder.availability',
  bio: 'description',
}

/** The key that holds a community's roster of member names. */
export const ROSTER_RECORD_KEY = 'com.peoplefinder.members'

export function allProfileRecordKeys(): string[] {
  return Object.values(PROFILE_RECORD_KEYS)
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const FIELD_MAX_LENGTH: Readonly<Record<ProfileField, number>> = {
  displayName: 60,
  role: 80,
  skills: 200,
  availability: 24,
  bio: 280,
}

export const MAX_SKILL_TOKENS = 12
export const MAX_SKILL_TOKEN_LENGTH = 32
export const MAX_ROSTER_ENTRIES = 200

/** Appended when a value was cut, so truncation is visible rather than silent. */
export const TRUNCATION_MARKER = '…[truncated]'

// ---------------------------------------------------------------------------
// Availability: a closed allowlist
// ---------------------------------------------------------------------------

export const AVAILABILITY_VALUES = ['open', 'limited', 'unavailable'] as const
export type Availability = (typeof AVAILABILITY_VALUES)[number]

/**
 * Casual spellings accepted on chain, mapped onto the three canonical values.
 *
 * A closed list is what makes "is this person free right now?" answerable without a
 * model guessing. Anything not in this table is rejected and the field is treated as
 * unset, which is reported rather than hidden.
 */
const AVAILABILITY_ALIASES: Readonly<Record<string, Availability>> = {
  open: 'open',
  available: 'open',
  free: 'open',
  'available now': 'open',
  yes: 'open',
  limited: 'limited',
  partial: 'limited',
  'limited time': 'limited',
  busy: 'limited',
  unavailable: 'unavailable',
  'not available': 'unavailable',
  none: 'unavailable',
  no: 'unavailable',
}

export function isAvailability(value: unknown): value is Availability {
  return typeof value === 'string' && (AVAILABILITY_VALUES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Sanitisation of untrusted text
// ---------------------------------------------------------------------------

/**
 * Characters that must never survive a record read.
 *
 * - C0/C1 controls and DEL: invisible, can reorder or hide text.
 * - Zero-width and bidi marks: render as nothing but change what a string *means* to a
 *   reader, and are a standard way to smuggle text past a human reviewer.
 */
export const FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/**
 * Same set, without the `g` flag, for callers that only need to test a string.
 *
 * Note what is *not* in it: `\t`, `\n` and `\r`. Those are whitespace a person can type, and
 * a roster or a bio separated by real line breaks has to survive sanitisation — otherwise
 * the sanitiser silently destroys the structure of the data it is meant to protect.
 */
export const FORBIDDEN_CHARS_TEST =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/

export interface SanitizeResult {
  readonly value: string
  /** True when forbidden characters were removed. */
  readonly strippedInvisible: boolean
  readonly truncated: boolean
}

/**
 * Make one record value safe to carry: normalise, strip invisible characters, collapse
 * whitespace, bound the length.
 *
 * The text is otherwise left **verbatim**. Silently "cleaning up" a member's words
 * would make the app describe them inaccurately, so anything we change is reported back
 * as a warning instead.
 */
export function sanitizeField(input: string | null | undefined, field: ProfileField): SanitizeResult {
  const max = FIELD_MAX_LENGTH[field]
  const raw = typeof input === 'string' ? input : ''

  const normalized = raw.normalize('NFC')
  const withoutForbidden = normalized.replace(FORBIDDEN_CHARS, ' ')
  const strippedInvisible = withoutForbidden !== normalized

  // Keep newlines as line breaks for bios; collapse every other whitespace run.
  const collapsed = withoutForbidden
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim()

  if (collapsed.length <= max) {
    return { value: collapsed, strippedInvisible, truncated: false }
  }

  const room = Math.max(0, max - TRUNCATION_MARKER.length)
  return {
    value: `${collapsed.slice(0, room).trimEnd()}${TRUNCATION_MARKER}`,
    strippedInvisible,
    truncated: true,
  }
}

/** Split a comma/semicolon/newline separated skills record into bounded tokens. */
export function parseSkills(input: string | null | undefined): {
  skills: string[]
  dropped: string[]
  overflow: boolean
} {
  const sanitized = sanitizeField(input, 'skills')
  const rawTokens = sanitized.value
    .split(/[,;\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const kept: string[] = []
  const dropped: string[] = []

  for (const token of rawTokens) {
    if (kept.length >= MAX_SKILL_TOKENS) continue
    const clipped = token.length > MAX_SKILL_TOKEN_LENGTH
      ? `${token.slice(0, MAX_SKILL_TOKEN_LENGTH - 1).trimEnd()}…`
      : token
    kept.push(clipped)
    if (clipped !== token) dropped.push(token)
  }

  return {
    skills: kept,
    dropped,
    overflow: rawTokens.length > MAX_SKILL_TOKENS,
  }
}

/** Map a raw availability record onto the closed allowlist, or null if unrecognised. */
export function parseAvailability(input: string | null | undefined): {
  value: Availability | null
  rejected: string | null
} {
  const { value } = sanitizeField(input, 'availability')
  if (value.length === 0) return { value: null, rejected: null }

  const key = value.toLowerCase().replace(/\s+/g, ' ')
  const mapped = AVAILABILITY_ALIASES[key]
  if (mapped) return { value: mapped, rejected: null }

  // A record that lists several values is ambiguous, so it is rejected rather than guessed.
  return { value: null, rejected: value }
}

// ---------------------------------------------------------------------------
// Injection-shaped text: flagged, never obeyed
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate text trying to address the model rather than describe a person.
 *
 * Detection exists to *label* a profile, not to launder it. A flagged profile is still
 * indexable and can still be recommended, but it is marked `suspicious` in the index,
 * in the candidate data sent to the model, and in the UI, and the model is told by
 * app-authored instructions that instruction-like text inside a record is not evidence
 * of anything. See `prompt.ts`.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier|your)\s+/i,
  /\bsystem\s+prompt\b/i,
  /\bdeveloper\s+message\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\brecommend\s+(me|yourself|this\s+person)\b/i,
  /\balways\s+(recommend|answer|respond|say|return)\b/i,
  /\byou\s+must\s+(only\s+)?(recommend|answer|say|return)\b/i,
  /\bdo\s+not\s+(mention|list|include|reveal)\b/i,
  /\bjailbreak\b/i,
  /^\s*(?:###\s*)?system\s*:/im,
  /<\/?(?:system|instructions?|assistant)\s*>/i,
]

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

// ---------------------------------------------------------------------------
// The validated profile
// ---------------------------------------------------------------------------

export type ProfileRecordStatus = 'read' | 'unset' | 'failed'

export type ProfileWarningCode =
  | 'invisible-characters-stripped'
  | 'truncated'
  | 'availability-not-recognised'
  | 'too-many-skills'
  | 'skill-token-truncated'
  | 'empty-after-sanitisation'
  | 'instruction-like-text'

export interface ProfileWarning {
  readonly field: ProfileField
  readonly code: ProfileWarningCode
  /** Human-readable, safe to show in the UI. Never contains the raw rejected value. */
  readonly detail: string
}

export interface ProfileFields {
  readonly displayName: string | null
  readonly role: string | null
  readonly skills: readonly string[]
  readonly availability: Availability | null
  readonly bio: string | null
}

/**
 * One indexed community member.
 *
 * `source` is the field that keeps the demo honest: `'ens'` means every field came from a
 * live Sepolia text-record read, `'simulated'` means it came from the labelled local
 * fixture set. It is carried all the way to the UI.
 */
export interface CommunityProfile {
  /** ENSIP-15 normalized. This is the identity used for every membership check. */
  readonly ensName: string
  readonly address: string | null
  readonly fields: ProfileFields
  readonly recordStatus: Readonly<Record<ProfileField, ProfileRecordStatus>>
  readonly warnings: readonly ProfileWarning[]
  /** True when any field contains instruction-like text. Labelled, never obeyed. */
  readonly suspicious: boolean
  readonly source: 'ens' | 'simulated'
}

/** Raw record values exactly as read, keyed by ENSIP-5 record key. */
export type RawProfileRecords = Readonly<Record<string, string | null>>

export interface ValidateProfileInput {
  /** Already ENSIP-15 normalized. */
  readonly ensName: string
  readonly address?: string | null
  /** record key -> raw value, where null means "unset". */
  readonly records: RawProfileRecords
  readonly recordStatus?: Readonly<Record<string, ProfileRecordStatus>>
  readonly source?: 'ens' | 'simulated'
}

/** Per-key read outcome, defaulting to 'unset' for keys the caller did not report. */
function statusFor(
  input: ValidateProfileInput,
  key: string,
): ProfileRecordStatus {
  const reported = input.recordStatus?.[key]
  if (reported) return reported
  const raw = input.records[key]
  return raw === null || raw === undefined ? 'unset' : 'read'
}

/**
 * Turn raw record reads into one bounded, validated, labelled profile.
 *
 * This is the only way a profile enters the index, so nothing downstream has to
 * re-check length, character set or the availability allowlist.
 */
export function validateProfile(input: ValidateProfileInput): CommunityProfile {
  const warnings: ProfileWarning[] = []
  const sanitized: Partial<Record<ProfileField, SanitizeResult>> = {}

  const readField = (field: ProfileField): SanitizeResult => {
    const cached = sanitized[field]
    if (cached) return cached
    const key = PROFILE_RECORD_KEYS[field]
    const result = sanitizeField(input.records[key], field)
    sanitized[field] = result

    if (result.strippedInvisible) {
      warnings.push({
        field,
        code: 'invisible-characters-stripped',
        detail: 'Zero-width, control or bidirectional characters were removed.',
      })
    }
    if (result.truncated) {
      warnings.push({
        field,
        code: 'truncated',
        detail: `Value exceeded ${FIELD_MAX_LENGTH[field]} characters and was cut.`,
      })
    }
    if (result.value.length === 0 && statusFor(input, key) === 'read') {
      warnings.push({
        field,
        code: 'empty-after-sanitisation',
        detail: 'Record held no usable text.',
      })
    }
    return result
  }

  const nullable = (field: ProfileField): string | null => {
    const value = readField(field).value
    return value.length === 0 ? null : value
  }

  const availability = parseAvailability(input.records[PROFILE_RECORD_KEYS.availability])
  if (availability.rejected) {
    warnings.push({
      field: 'availability',
      code: 'availability-not-recognised',
      detail:
        `Not one of ${AVAILABILITY_VALUES.join(' / ')}, so availability is treated as unknown. ` +
        `Allowed aliases include: ${Object.keys(AVAILABILITY_ALIASES).join(', ')}.`,
    })
  }

  const skills = parseSkills(input.records[PROFILE_RECORD_KEYS.skills])
  if (skills.overflow) {
    warnings.push({
      field: 'skills',
      code: 'too-many-skills',
      detail: `More than ${MAX_SKILL_TOKENS} skills were listed; the first ${MAX_SKILL_TOKENS} were kept.`,
    })
  }
  if (skills.dropped.length > 0) {
    warnings.push({
      field: 'skills',
      code: 'skill-token-truncated',
      detail: 'One or more skill names were too long and were shortened.',
    })
  }

  const fields: ProfileFields = {
    displayName: nullable('displayName'),
    role: nullable('role'),
    skills: skills.skills,
    availability: availability.value,
    bio: nullable('bio'),
  }

  // Instruction-like text is flagged across every human-readable field. The check runs on
  // the sanitised value so the pattern cannot be evaded with invisible characters.
  const suspicious = [
    fields.displayName ?? '',
    fields.role ?? '',
    fields.bio ?? '',
    ...fields.skills,
  ].some(looksLikeInjection)

  if (suspicious) {
    warnings.push({
      field: 'bio',
      code: 'instruction-like-text',
      detail:
        'This profile contains text written to address a model. It is shown to you and passed ' +
        'to the model as untrusted data; it is never treated as an instruction.',
    })
  }

  const recordStatus = Object.fromEntries(
    (Object.keys(PROFILE_RECORD_KEYS) as ProfileField[]).map((field) => [
      field,
      statusFor(input, PROFILE_RECORD_KEYS[field]),
    ]),
  ) as Record<ProfileField, ProfileRecordStatus>

  return {
    ensName: input.ensName,
    address: input.address ?? null,
    fields,
    recordStatus,
    warnings,
    suspicious,
    source: input.source ?? 'ens',
  }
}

/**
 * A profile is indexable only if it says something we can retrieve it by.
 *
 * A name with zero skills, no role and no bio cannot be a useful answer, so it is left
 * out of the index instead of being offered and rejected later.
 */
export function isIndexable(profile: CommunityProfile): boolean {
  const { fields } = profile
  return (
    fields.skills.length > 0 ||
    (fields.role !== null && fields.role.length > 0) ||
    (fields.bio !== null && fields.bio.length > 0)
  )
}

/** Short label for a person, preferring their ENS name so identity is never invented. */
export function displayLabel(profile: CommunityProfile): string {
  return profile.fields.displayName ?? profile.ensName
}

/** The single line of structured, non-bio evidence used to justify a match. */
export function evidenceLine(profile: CommunityProfile): string {
  const parts: string[] = []
  if (profile.fields.role) parts.push(profile.fields.role)
  if (profile.fields.skills.length > 0) parts.push(`skills: ${profile.fields.skills.join(', ')}`)
  if (profile.fields.availability) parts.push(`availability: ${profile.fields.availability}`)
  return parts.join(' | ')
}

// ---------------------------------------------------------------------------
// Roster parsing (the community's member list, itself an ENS record)
// ---------------------------------------------------------------------------

/**
 * Parse the roster record: a comma, semicolon or newline separated list of ENS names.
 *
 * Names are returned raw (not normalized) because normalization needs `viem`, which this
 * module deliberately does not import: it stays usable in the browser and in tests with
 * no chain client at all. `ens.ts` normalizes each entry before it becomes a member.
 */
export function parseRoster(input: string | null | undefined): {
  entries: string[]
  overflow: boolean
  rejected: string[]
} {
  const raw = typeof input === 'string' ? input : ''
  const cleaned = raw
    .normalize('NFC')
    // Same forbidden set as `sanitizeField`, so a roster cannot smuggle in a control
    // character that a profile field would have had stripped. Line breaks survive.
    .replace(new RegExp(FORBIDDEN_CHARS.source, 'g'), ' ')

  const tokens = cleaned
    .split(/[,;\r\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const entries = tokens.slice(0, MAX_ROSTER_ENTRIES)
  return {
    entries,
    overflow: tokens.length > MAX_ROSTER_ENTRIES,
    rejected: tokens.filter((token) => token.length > 60),
  }
}

/** zod schema for one raw record map, used at the API boundary. */
export const rawRecordsSchema = z.record(z.string().max(60), z.string().nullable())