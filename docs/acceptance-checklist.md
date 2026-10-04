# Acceptance checklist — Who In Here Can Help Me?

Per-criterion status for the eight scored test cases in `p2.md`.

**Read this first.** Three things in this repository are *not* claimed, and no line below should
be read as claiming them:

1. **The scored Agent Harness evaluation has not been run.** It is deferred until all three MVPs
   exist. `npm run harness:check` runs repository-local gates and computes **no score**.
   `loops evaluate` returns an evaluator *prompt* to be executed by hand, not a pass/fail result.
2. **The test community is not published.** No ENS record has been written for any of the nine
   planned names, so a live run reads nothing from Sepolia and uses the labelled simulated index.
3. **A hosted model provider was not used.** The default local model runs through Ollama on this
   machine; the model and host used for any recorded run are named in
   [`docs/expected-queries.md`](./expected-queries.md).

What each criterion *claims* below is supported by code in this repository plus a named test.
Pointing at a line is a claim you can check by reading it.

---

## 1. Every person in the answer is checked against the retrieved candidates — 22 pts

**Status: implemented, tested.**

- `enforceCandidateMembership()` in `src/shared/model-output.ts:165` re-normalizes every name
  the model produced (ENSIP-15, via `normalizeEnsName`) and looks it up in the retrieved
  candidate set built at `src/shared/model-output.ts:173`.
- A name not in that set is rejected with code `not-in-candidates` and is **never** displayed as
  a person. `parseModelAnswer` throws rather than returning a name it cannot check
  (`src/shared/model-output.ts:118`).
- Rejected names are returned to the caller, not silently dropped, so the UI can show that
  something was removed and why (`src/shared/model-output.ts:50`).
- Identity, evidence and availability badges are copied from the **candidate's own records**,
  never from the model's text (`src/shared/model-output.ts:68`).

Tests: `src/shared/model-output.test.ts`, plus in `src/server/api.test.ts` the cases
*rejects a name the model invented*, *rejects a real but non-member name invented by the model*
(`satoshi.eth`, `vitalik.eth`), and *rejects a duplicate*, all driven by a deliberately
compromised model.

## 2. Only a bounded number of candidates is sent to the model — 10 pts

**Status: implemented, tested.**

- `retrieveCandidates()` slices to `topK` at `src/shared/retrieval.ts:330`, after dropping
  everything below `minScore`, so the prompt size is bounded on both axes.
- `topK` itself is clamped: `Math.min(MAX_TOP_K, Math.max(1, …))` with `MAX_TOP_K = 20`
  (`src/shared/retrieval.ts:45` and `:340`). An oversized configured value cannot enlarge the
  prompt.
- A second, independent guard at the HTTP boundary: `askModel` throws `CandidateLimitError`
  before any request if `candidates.length > config.topK` (`src/server/llm.ts:161`).
- The bound in force is reported in every response (`retrieval.topK`) and in `/api/health`.

Tests: `src/shared/retrieval.test.ts` (*never returns more candidates than top-k, even with a
huge matching community*, *caps an oversized top-k instead of trusting it*, *drops everything
below the relevance floor*), and `src/server/api.test.ts`.

## 3. Profile text is never interpolated into the system prompt — 12 pts

**Status: implemented, tested.**

- `buildSystemMessage()` (`src/shared/prompt.ts:69`) takes **no arguments**. There is no
  parameter through which profile text could arrive.
- `buildChatMessages()` sends three separate messages
  (`src/shared/prompt.ts:129`): the app-authored system message, the user's question, and a
  separate candidate-data message. Profile content appears only in the third.
- Belt-and-braces: `findProfileLeakage()` (`src/shared/prompt.ts:148`) scans the system message
  for profile substrings and `askModel` throws `ProfileLeakageError` if any are found
  (`src/server/llm.ts:168`).
- The candidate-data message is assembled from a bounded projection of each profile
  (`toCandidatePayload`, `src/shared/prompt.ts:85`), not from the raw record map.

Tests: `src/shared/prompt.test.ts` (*the system message takes no arguments*,
*no profile text reaches the system message*), plus the leakage-guard tests.

## 4. The index is built from ENS text record reads — 8 pts

**Status: implemented, tested. Nothing in this repo hardcodes an answer.**

- `readProfileRecords()` in `src/server/ens.ts:126` reads each profile key through
  `readTextViaUniversalResolver` (`src/server/ens.ts:103`) on `sepolia` (chain id `11155111`),
  with an explicit per-call RPC timeout.
- The member list is itself a record read: `readRosterRecord()` (`src/server/ens.ts:207`) reads
  `com.peoplefinder.members` from the community root. `rosterSource` in the response says
  whether the roster came from the chain (`ens-record`) or from configuration.
- `CommunityIndex.refresh()` (`src/server/community.ts:152`) re-reads the roster and every
  member, so a profile edited on Sepolia appears on the next refresh with no code change.
- Verified live: `npm run probe:community` performs real Sepolia reads through viem.

Tests: `src/server/api.test.ts` (*reads the roster and every profile from ENS when the chain
answers*, *reports which records were unset or unreadable per key*), `src/server/community.test.ts`.

**Caveat, stated plainly:** because the community is not published, the only path exercised end
to end against a real chain today reads *nothing*. The simulated index is derived from the same
planned records and is labelled `source: "simulated"` everywhere it appears.

## 5. An empty match produces an explicit no-match response — 8 pts

**Status: implemented, tested.**

- Retrieval returning zero candidates short-circuits at `src/server/find.ts:141` and returns
  `noMatch: true` **without any model request**. The response says so in
  `model.skippedReason`.
- A second branch exists for the other empty case: the availability gate emptied the candidate
  set, in which case the unavailable people are named as near-misses so the answer explains
  itself (`src/server/find.ts:192`).
- If the model itself answers "no match" after being called, that is respected too, with a
  reason (`src/server/find.ts:192`).
- The UI renders a dedicated no-match panel with the reason, not a blank state.

Tests: `src/server/api.test.ts` (*returns an explicit no-match when retrieval finds nobody, and
makes no model request*, *names the unavailable people it excluded*, *a model that says no match
is believed*).

## 6. Recorded test queries state their expected members — 8 pts

**Status: implemented, tested, and recorded against a real run.**

- Nine cases in `src/shared/expected-queries.json`, each with `mustInclude` / `mustNotInclude` /
  `mayInclude` of **specific ENS names**, or `expect: "no-match"` with a `why`. Two cases are
  deliberately adversarial (a name absent from the community, and a request to ignore the tool).
- `judgeCase()` in `src/shared/expected-queries.ts` enforces the expectations; the dataset
  itself is validated by `src/shared/expected-queries.test.ts`, which also checks that every
  expected name is a real indexable member.
- `npm run record` runs the dataset against a live app and writes
  [`docs/expected-queries.md`](./expected-queries.md) with the model, host, index source, timestamp
  and per-case observed result. A run that cannot reach the model is recorded as a failure, not
  as passes.

## 7. The model request has an explicit timeout — 6 pts

**Status: implemented, tested.**

- `LLM_TIMEOUT_MS` is a required-with-default configuration value (1 000–300 000 ms,
  default 20 000) validated by `src/server/config.ts`.
- Each attempt is bounded by an `AbortController` created in `src/server/llm.ts:180`, and the
  timer is always cleared in a `finally` block so a pending timer can never hold the process open.
- A timeout is a **hard stop**: it is not retried, because retrying a call that already exceeded
  its budget would defeat the bound (`src/server/llm.ts:283`).
- Retries exist only for retryable statuses and are bounded to three attempts with `Retry-After`
  honoured and capped, so the total time is bounded too.
- The output is bounded as well: `LLM_MAX_TOKENS` (default 600) caps the answer, complementing
  the `topK` cap on the input. Both are reported in `/api/health`.

Tests: `src/server/api.test.ts` (*surfaces a model failure as an error rather than as an invented
person*, against a provider that never answers).

## 8. No credential appears in any tracked file — 6 pts

**Status: implemented, negative-tested.**

- `npm run check:secrets` runs `scripts/scan-secrets.mjs`, which walks every file git does not
  ignore and fails on credential-shaped content: `sk-…` keys, `ghp_`/`github_pat_` tokens, AWS
  access key ids, `-----BEGIN … PRIVATE KEY-----`, 64-hex mnemonics, provider key headers, and
  **literal assignments** of a secret-looking name to a non-empty, non-placeholder value.
- `.env` is git-ignored, so it is never tracked, and it contains no credential: the local setup
  uses Ollama, which needs no key.
- `.env.example` is tracked and holds placeholders only. There is deliberately no signing-key
  entry, because the app has no signing code: ENS reads are `eth_call`, and publishing is signed
  by the member's own wallet.
- The scanner was negative-tested: a synthetic `sk-…` value and a literal `LLM_API_KEY=<secret>`
  assignment were each detected, and the scratch files were removed.

---

## Summary

| # | Criterion | Points | Status here |
| --- | --- | --- | --- |
| 1 | Candidate membership check | 22 | Implemented + tested |
| 2 | Bounded candidate count | 10 | Implemented + tested, two independent guards |
| 3 | No profile text in the system prompt | 12 | Implemented + tested, zero-argument builder |
| 4 | Index from ENS record reads | 8 | Implemented + tested; community not yet published |
| 5 | Explicit no-match branch | 8 | Implemented + tested |
| 6 | Recorded queries with expected members | 8 | 9 cases + recorded real run |
| 7 | Explicit model timeout | 6 | Implemented + tested, retries bounded |
| 8 | No credential in tracked files | 6 | Implemented + negative-tested |

**This table summarises local evidence. It is not a score.** No scored evaluation has been run.

## Last verified run

Everything below was observed on this machine, not asserted:

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| Tests | `npm run test` | **137 passed, 0 failed** across 7 files |
| Credential scan | `npm run check:secrets` | 42 files read, no credential-shaped content |
| Production build | `npm run build` | built, `dist/web` 160 kB JS / 8.5 kB CSS |
| Local gates | `npm run harness:check` | **green**, log in [`harness-run-log.md`](./harness-run-log.md) |
| Recorded cases | `npm run record` | **9 of 9 passed** with `qwen2.5:3b`, 9 of 9 reachable without a model |
| Live server | `npm start` | `/api/health` reports index ready, 9 members, roster source `simulated` |
| UI through the dev proxy | `npm run dev:web` | app shell, `main.tsx`, and a proxied `POST /api/find` all served |

Two notes on that recorded run, so the number is not read as more than it is:

- It ran against the **labelled simulated index**, not published Sepolia records.
- `qwen2.5:3b` is a 3 B local model. It answered all nine cases, but the earlier `qwen3:4b`
  configuration could not: it spent its whole token budget on private reasoning and returned no
  JSON at all. The prompt, the token bound and the diagnostics in `src/server/llm.ts` exist
  because that failure was real.

## Reproducing the local evidence

```bash
npm install
npm run check          # typecheck + tests + secret scan
npm run harness:check  # the above + production build + required-documents check
npm run probe:community              # real Sepolia reads; reports what exists
npm run record                      # re-record the expected queries against a real run
```

Known environment limitation, not an app defect: `npm install` reports five audit findings
(three moderate, one high, one critical) in the transitive dependency tree. No breaking
`npm audit fix --force` has been run, because force-fixing would change versions across the
`@midnight-ntwrk`, viem and zod trees that the app depends on.