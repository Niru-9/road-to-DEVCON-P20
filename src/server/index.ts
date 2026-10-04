/**
 * The API.
 *
 * A server-side boundary exists for one reason: the model credentials must never reach the
 * browser. The bundle contains no API key, no provider endpoint and no RPC URL. Everything
 * below runs in Node.
 *
 * Routes
 *   GET  /api/health             configuration the UI needs, redacted
 *   GET  /api/community          the current index state (no chain read)
 *   POST /api/community/refresh  re-read the roster and every member from Sepolia
 *   POST /api/find               ask a question; returns matches or an explicit no-match
 *   GET  /api/examples           the recorded test queries, for one-click demo
 *
 * Read-only profile lookup never requires a connected wallet. MetaMask is an optional
 * convenience in the UI; nothing on this server reads it.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'

import { ConfigError, getConfig, toPublicConfigView, type AppConfig } from './config'
import { CommunityIndex, type CommunityIndexState } from './community'
import { createEnsClient, READ_RECORD_KEYS, type EnsTextReader } from './ens'
import {
  CandidateLimitError,
  ModelProviderError,
  ModelTimeoutError,
  ProfileLeakageError,
  askModel,
} from './llm'
import { findPeople } from './find'
import { ModelOutputError } from '../shared/model-output'
import { EXAMPLE_QUERIES, EXPECTED_QUERIES } from '../shared/expected-queries'
import { PLANNED_COMMUNITY_ROOT, SIMULATED_NOTICE } from '../shared/demo-community'
import { AVAILABILITY_VALUES, PROFILE_RECORD_KEYS, ROSTER_RECORD_KEY } from '../shared/profile'
import { RETRIEVAL_DEFAULTS } from '../shared/retrieval'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..', '..')

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const MAX_QUESTION_LENGTH = 500
const MAX_BODY = '32kb'

const findSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, 'Ask a question of at least 3 characters.')
    .max(MAX_QUESTION_LENGTH, `Keep the question under ${MAX_QUESTION_LENGTH} characters.`),
  /**
   * Refresh first if the index is stale or empty. Explicit rather than implicit, so a slow
   * chain read never silently happens inside a question.
   */
  refreshFirst: z.boolean().optional().default(false),
})

function fail(res: Response, status: number, code: string, message: string, extra?: unknown): void {
  res.status(status).json({ error: { code, message, ...(extra ? { detail: extra } : {}) } })
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function indexSummary(state: CommunityIndexState) {
  return {
    status: state.status,
    refreshedAt: state.refreshedAt,
    root: state.root,
    rosterSource: state.rosterSource,
    rosterStatus: state.rosterStatus,
    rosterError: state.rosterError,
    rosterRecordKey: ROSTER_RECORD_KEY,
    attemptedNames: state.attemptedNames,
    rejectedNames: state.rejectedNames,
    emptyProfiles: state.emptyProfiles,
    failedProfiles: state.failedProfiles,
    partial: state.partial,
    notices: state.notices,
    error: state.error,
    durationMs: state.durationMs,
    memberCount: state.profiles.length,
    simulated: state.rosterSource === 'simulated',
    profiles: state.profiles.map((profile) => ({
      ensName: profile.ensName,
      address: profile.address,
      fields: profile.fields,
      recordStatus: profile.recordStatus,
      warnings: profile.warnings,
      suspicious: profile.suspicious,
      source: profile.source,
    })),
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Injection seams.
 *
 * Production passes nothing and gets the real provider call and the real RPC. Tests pass a
 * fake `ask` to exercise the full HTTP path — including the membership check against a
 * deliberately hostile model — with no network, and a fake `readText` to serve ENS records
 * from memory.
 */
export interface AppDeps {
  readonly ask?: typeof askModel
  readonly readText?: EnsTextReader
}

export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const app = express()
  app.use(express.json({ limit: MAX_BODY }))

  const ensClient = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
  const index = new CommunityIndex({ client: ensClient, config, readText: deps.readText })

  app.get('/api/health', (_req: Request, res: Response) => {
    const state = index.getState()
    res.json({
      ok: true,
      chain: 'sepolia',
      chainId: 11155111,
      config: toPublicConfigView(config),
      index: {
        status: state.status,
        memberCount: state.profiles.length,
        refreshedAt: state.refreshedAt,
        rosterSource: state.rosterSource,
      },
      recordKeys: READ_RECORD_KEYS,
      availabilityValues: AVAILABILITY_VALUES,
      retrievalDefaults: RETRIEVAL_DEFAULTS,
      /** Wallet-free by design, stated so the UI can say it out loud. */
      walletRequired: false,
      notice: 'ENS reads are eth_call. No wallet is needed to look up profiles.',
    })
  })

  app.get('/api/community', (_req: Request, res: Response) => {
    res.json(indexSummary(index.getState()))
  })

  app.post('/api/community/refresh', (_req: Request, res: Response) => {
    void index
      .refresh()
      .then((state) => res.json(indexSummary(state)))
      .catch((error: unknown) => handleUnexpected(res, error))
  })

  app.get('/api/examples', (_req: Request, res: Response) => {
    res.json({
      communityRoot: EXPECTED_QUERIES.communityRoot,
      status: EXPECTED_QUERIES.status,
      problem: EXPECTED_QUERIES.problem,
      cases: EXAMPLE_QUERIES.map((testCase) => ({
        id: testCase.id,
        question: testCase.question,
        expect: testCase.expect,
        mustInclude: testCase.mustInclude,
        mayInclude: testCase.mayInclude,
        mustNotInclude: testCase.mustNotInclude,
        why: testCase.why,
      })),
    })
  })

  app.post('/api/find', (req: Request, res: Response) => {
    const parsed = findSchema.safeParse(req.body)
    if (!parsed.success) {
      fail(res, 400, 'BAD_REQUEST', 'Provide a question in plain language.', parsed.error.issues)
      return
    }

    const { question, refreshFirst } = parsed.data

    void (async () => {
      if (refreshFirst) await index.refresh()

      const result = await findPeople({ question, index, config, ask: deps.ask })
      res.json(result)
    })().catch((error: unknown) => {
      if (error instanceof ModelTimeoutError) {
        fail(res, 504, 'MODEL_TIMEOUT', error.message, { timeoutMs: error.timeoutMs })
        return
      }
      if (error instanceof ModelProviderError) {
        fail(res, 502, 'MODEL_ERROR', error.message, { status: error.status })
        return
      }
      if (error instanceof ModelOutputError) {
        fail(res, 502, 'MODEL_OUTPUT_UNUSABLE', error.message, { detail: error.detail })
        return
      }
      if (error instanceof CandidateLimitError) {
        fail(res, 500, 'CANDIDATE_LIMIT', error.message, {
          sent: error.sent,
          limit: error.limit,
        })
        return
      }
      if (error instanceof ProfileLeakageError) {
        // A real bug. Surface it rather than hiding it.
        fail(res, 500, 'PROFILE_LEAKAGE', error.message, { leaks: error.leaks })
        return
      }
      handleUnexpected(res, error)
    })
  })

  function handleUnexpected(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    // RPC timeouts and Node network failures land here.
    fail(res, 502, 'UPSTREAM_ERROR', `Could not complete the request: ${message}`)
  }

  app.use('/api', (_req: Request, res: Response) => {
    fail(res, 404, 'NOT_FOUND', 'Unknown API route.')
  })

  // Serve the built UI when it exists (production / single-port demo).
  const webDist = join(repoRoot, 'dist', 'web')
  if (existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  return app
}

/** Exposed so tests can inspect the same index the routes use. */
export type AppContext = ReturnType<typeof createApp>

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  let config: AppConfig
  try {
    config = getConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  const app = createApp(config)
  const view = toPublicConfigView(config)

  app.listen(config.port, () => {
    console.log('')
    console.log('  Community People Finder')
    console.log('  ENS:     Sepolia (chain id 11155111)')
    console.log(`  Community root: ${view.communityRoot} (roster via ${ROSTER_RECORD_KEY})`)
    console.log(`  Model:   ${view.model} @ ${view.providerHost}`)
    console.log(`  Timeout: ${view.timeoutMs} ms, ${view.maxTokens} answer tokens max per model request`)
    console.log(`  Top-k:   ${view.topK} candidates max per question`)
    console.log(`  API key: ${view.hasApiKey ? 'present (server-side only)' : 'not set (local provider is fine)'}`)
    console.log(`  RPC:     ${view.rpcHost}`)
    console.log(`  Wallet:  not required - ENS reads are eth_call`)
    console.log(`  Simulated index: ${view.allowSimulatedIndex ? 'allowed when live roster is empty (clearly labelled)' : 'disabled'}`)
    console.log('')
    console.log(`  ready on http://localhost:${config.port}`)
    console.log('')
    void warmUp(config, view.communityRoot)
  })
}

/**
 * Read the community once at boot so the first question is fast.
 *
 * Failure is non-fatal: the state carries the error and the UI offers a refresh button.
 */
async function warmUp(config: AppConfig, root: string): Promise<void> {
  try {
    const ensClient = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
    const index = new CommunityIndex({ client: ensClient, config })
    const state = await index.refresh()
    console.log(
      `  index: ${state.profiles.length} profile(s) from ${state.rosterSource}; refreshed in ${state.durationMs} ms`,
    )
    if (state.rosterSource === 'simulated') {
      console.log(`  NOTE: ${SIMULATED_NOTICE}`)
    }
  } catch (error) {
    console.log(`  index: could not warm up (${error instanceof Error ? error.message : String(error)})`)
    console.log(`  community root: ${root}`)
  }
}

// Only start listening when executed directly, so tests can import createApp.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
}

/** Documented format constants, re-exported for docs scripts. */
export { PROFILE_RECORD_KEYS, PLANNED_COMMUNITY_ROOT }