# action.md — P2 "Community People Finder" (Road To Devcon VII)

Persistent handoff log for this repository. Source of truth for cross-session continuity.
Status legend: `TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED` / `FAILED`

## Problem

Build the P2 MVP only: **Community People Finder** — "Who In Here Can Help Me?".

A builder community member asks a question in plain language ("who can mentor me in Rust this
month?"). The app loads community member profiles **from live ENS text records on Sepolia**,
retrieves a **bounded top-k candidate set**, asks a configured model to pick real people from
*only* those candidates, then **validates the model's output against the candidate set** before
displaying anything — and returns an **explicit no-match** answer when nobody fits.

Deliverable: a public-ready repo with the people finder, the list of Sepolia names in the test
community, and the recorded test queries with their expected members.

## Goal

Ship a complete, professional, demo-ready P2 MVP that satisfies **all 8 scored checks in
`p2.md`** (80 points), verified later with the Agent Harness scored evaluation + stress-test
cycle, plus deterministic local checks and a documented evidence trail.

## The 8 scored acceptance criteria (from `p2.md`)

| # | Criterion | Pts |
|---|-----------|-----|
| 1 | Every person in the answer is checked against the retrieved candidates | 22 |
| 2 | Only a bounded number of candidates is sent to the model | 10 |
| 3 | Profile text is never interpolated into the system prompt | 12 |
| 4 | The index is built from ENS text record reads | 8 |
| 5 | An empty match produces an explicit no-match response | 8 |
| 6 | Recorded test queries state their expected members | 8 |
| 7 | The model request has an explicit timeout | 6 |
| 8 | No credential appears in any tracked file | 6 |

## Constraints for this phase

- Work inside `p2/` only. **Do not modify P1 or P3. Do not modify the Dev8 root `.env`.**
- Do **not** commit or push.
- No ENS **write** transactions in this phase. Sepolia record publishing/read-back happens later,
  during front-end review, with MetaMask. Nothing may claim the test community is seeded.
- Never place credentials, API keys, private keys, or authenticated RPC URLs in tracked files or
  browser bundles. Ignored P2-local `.env`; placeholder-only `.env.example`.
- Never ask the user to paste secrets into chat.
- Read-only profile lookup must work **without** a connected wallet; MetaMask is optional and only
  ever used for connect/disconnect + address/network status (and, later, publishing).
- The full 8-check P2 harness scored evaluation + stress-test cycle runs **after all three MVPs**.
  It is **not** run in this coding phase, and no custom script suite substitutes for it.
- Never claim a scored check passes without the harness confirming it.

## Target architecture (mirrors P1's stack, per `plan.md`)

- TypeScript, Node 22, Vite + React single-screen UI, small Express API server.
- `viem` for ENSIP-15 `normalize()` + Sepolia `getEnsText()` through the Universal Resolver.
- `zod` for validation at every boundary (records, model output, request bodies).
- One OpenAI-compatible chat API configured purely by env vars, **server-side only**.
- Retrieval is deterministic lexical scoring (no embeddings) so the demo needs no extra provider
  budget; embeddings are explicitly out of scope for this MVP.

### P2-specific design decisions

1. **Community discovery is itself an ENS read.** A configured community root name carries a
   roster text record listing its members. Refresh re-reads the roster and every member's profile
   from chain. A configured member list is only a fallback, and is labelled as such.
2. **Profile format** = ENSIP-5 keys: standard global keys `name` / `description` plus
   `com.peoplefinder.*` service keys for `role`, `skills`, `availability`.
3. **`buildSystemMessage()` takes zero arguments** — it is structurally impossible for profile text
   to reach the system prompt. Candidates go in their own `user` message, separate from the
   question's own `user` message.
4. **Hard no-match branch**: if retrieval returns nothing above threshold, the request returns an
   explicit no-match response and **the model is never called**.
5. **Membership enforcement**: every ENS name in the model output is re-normalized and checked
   against the retrieved candidate set; anything not in that set is dropped and reported.

---

## Task log

### T0 — Session bootstrap and environment verification
- **Status:** `DONE`
- **Description:** Read `p2.md` + `plan.md`; verify Node/git; inventory `p2/`.
- **Intended outcome:** Environment known, task list created, this log exists.
- **Progress:**
  - Read Dev8 root `p2.md` (114 lines: brief, 8 scored checks) and `plan.md` (P2 section,
    lines 202–206, plus shared working agreement).
  - Read root `action.md` (P1 log) and inspected `p1/` to reuse its proven conventions.
  - `node -v` → `v22.22.0` (≥20.12 required, 22 LTS preferred ✅), `npm -v` → `11.6.2`.
  - `p2/` contained **only** `p2.md` (a copy of the brief). No package.json, no `.env`,
    no `action.md`, no source. Nothing to preserve or overwrite.
  - P1 is complete for coding; it is read-only for this session. P3 out of scope.
- **Verification:** `node --version`, `Get-ChildItem p2 -Force -Recurse` → only `p2\p2.md`.

### T1 — Agent Harness installed from `p2/` + knowledge-graph query
- **Status:** `DONE` (installed and queried; graph returned no evidence — real limitation)
- **Description:** Confirm Node ≥20.12, run `npx loopshouse add road-to-devcon-vii` from `p2/`
  unless already initialized there, complete browser sign-in, read the installed skill, and query
  the `community-people-finder` knowledge graph.
- **Intended outcome:** Harness present inside `p2/`, signed in, and design uncertainties resolved
  or recorded as genuine limitations.
- **Commands and observed results:**
  - `node --version` → `v22.22.0` ✅ (≥20.12 required, 22 LTS preferred).
  - `p2/` was **not** harness-initialized (only `p2.md` existed), so the documented install was run
    **from `p2/`**: `npx --yes loopshouse@0.5.0 add road-to-devcon-vii --yes` → **SUCCESS**.
    Wrote `p2\.claude\skills\loops-road-to-devcon-vii\SKILL.md` and
    `p2\.agents\skills\loops-road-to-devcon-vii\SKILL.md`; `cli: 0.5.0`;
    `authenticated: true`; `Signed in as ndkindia09@gmail.com` (browser sign-in completed).
    Pinned `0.5.0` deliberately: P1's log records that a bare `npx loopshouse` resolved a stale
    cached `0.4.0` and failed with `SKILL_FETCH_FAILED`.
  - `loops auth status` → `authenticated: true`, `userId 932a34dc-…`.
    `loops credits --event road-to-devcon-vii` → `{used: 5, cap: 100, remaining: 95}`.
  - **Read the installed skill** (`.agents/skills/loops-road-to-devcon-vii/SKILL.md`, 171 lines).
    Its documented commands, used verbatim and nothing invented: `loops auth status`,
    `loops --version`, `loops enroll`, `loops knowledge query --event … --problem <slug> -q`,
    `loops project get|create|update`, `loops evaluate --event … --problem <slug>`.
    Confirmed P2 slug is **`community-people-finder`** ("Who In Here Can Help Me?").
  - **Same critical nuance as P1 recorded, so this session does not overclaim:** the skill states
    `loops evaluate` *"Fetch[es] a self-contained evaluator prompt … then **execute the prompt
    yourself inside the project repo**"*. It is **not** a pass/fail runner and emits no
    machine-readable criterion results. So `npm run harness:check` in this repo is a **repo-local
    wrapper** that fetches the prompt and runs the local gates, and it computes **no score**.
- **Knowledge-graph queries (3 run, all empty — same as P1):**
  1. `-q "What ENS text record format should community member profiles use, and how should the community member list be discovered from a parent ENS name on Sepolia?"`
  2. `-q "scored acceptance criteria for Who In Here Can Help Me candidate membership check no-match"`
  3. `-q "prompt injection in ENS bio records adversarial profile retrieval top-k grounding"`
  - Verbatim result of each: `{"evidence":"No relevant context was retrieved for this query. Try a more specific query."}`
  - **Conclusion:** the `community-people-finder` knowledge graph is **not yet indexed** (event
    opened Oct 2 2026; the skill itself warns *"Problem briefs, stacks, and rubrics unlock when the
    event starts"*). So `p2.md`, `plan.md`, ENSIP-5 and ENSIP-15 are the authority for the record
    format and criteria in this build. Recorded as a genuine limitation, not glossed over.
- **Next step:** T2 — scaffold.

### T2 — Repo skeleton + config hygiene
- **Status:** `DONE`
- **Description:** `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
  `.gitignore` (P2-local, `.env` ignored), placeholder-only `.env.example`, P2-local ignored
  `.env`, `docs/` tree.
- **Intended outcome:** `npm install` succeeds; server boots with actionable config errors.
- **Verification:** `npm install` → succeeds. Config is parsed by zod in
  `src/server/config.ts`; every value is bounds-checked and a bad value fails at boot with the
  variable name and the accepted range. `npm run check:secrets` passes.
- **Known, not fixed:** `npm install` reports five audit findings in the transitive tree (three
  moderate, one high, one critical). `npm audit fix --force` is **not** run: it changes versions
  across the viem/zod trees the app depends on. Recorded in `docs/acceptance-checklist.md`.

### T3 — ENS profile record format + validation/bounding
- **Status:** `DONE`
- **Description:** Documented ENSIP-5 key set; per-field bounds; sanitisation of untrusted text;
  availability allowlist; per-key read status (`read` / `unset` / `failed`).
- **Intended outcome:** Nothing unvalidated or unbounded can enter the index.
- **Where:** `src/shared/profile.ts` (`validateProfile`, `sanitizeField`, `parseSkills`,
  `parseAvailability`, `looksLikeInjection`, `isIndexable`), documented in
  `docs/profile-format.md`.
- **Verification:** `src/shared/profile.test.ts` — bounds, truncation markers, invisible-character
  stripping, rejected availability, injection detection, indexability.

### T4 — Deterministic retrieval with explicit top-k
- **Status:** `DONE`
- **Description:** Field-weighted lexical scoring, explicit `TOP_K_CANDIDATES` constant and score
  threshold, matched-term evidence per candidate.
- **Intended outcome:** Only a bounded, explicit candidate set can ever reach the model.
- **Where:** `src/shared/retrieval.ts` — `retrieveCandidates` slices to `topK` after the
  `minScore` floor, `topK` is clamped to `MAX_TOP_K = 20`, and `askModel` re-checks the bound at
  the HTTP boundary.
- **Later in the session:** conservative suffix folding was added (`stemToken`) so an inflected
  question finds the member who published the other form, plus a four-character floor on prefix
  matching. Both are covered by regression tests, including the two-letter-prefix bug
  (`de` matching `dentist`) that the fold initially introduced.
- **Verification:** `src/shared/retrieval.test.ts` — 25 tests.

### T5 — Prompt construction (app-authored system, separate data message)
- **Status:** `DONE`
- **Description:** Zero-argument `buildSystemMessage()`; separate question message; separate
  bounded candidate-data message; leakage guard.
- **Intended outcome:** Profile text is structurally incapable of reaching the system prompt.
- **Verification:** `src/shared/prompt.test.ts`.

### T6 — Model output validation + candidate membership enforcement
- **Status:** `DONE`
- **Description:** zod-validated structured output; re-normalized membership check against the
  retrieved candidates; rejected names reported, never displayed as people.
- **Intended outcome:** A hallucinated person can never be shown.
- **Verification:** `src/shared/model-output.test.ts`, plus the compromised-model API tests.

### T7 — Server: ENS reads, community index + refresh, `/api/find`, model call
- **Status:** `DONE`
- **Description:** Live roster + profile reads through the Universal Resolver; in-memory index with
  refresh and status; `/api/health`, `/api/community`, `/api/community/refresh`, `/api/find`;
  explicit no-match branch with **no model call**; explicit model timeout.
- **Intended outcome:** Whole flow works end to end over real HTTP.
- **Injection seam:** `createApp(config, { ask, readText })` exists so the API can be tested
  against a cooperative model, a compromised model and a fake chain. Production passes neither.
- **Verification:** `src/server/api.test.ts` (18 tests), `src/server/community.test.ts`,
  `npm run probe:community` (real Sepolia reads).

### T8 — Browser UI (wallet optional) + refresh/loading/error status
- **Status:** `DONE`
- **Description:** Professional responsive single screen under `src/web/`: index panel with
  refresh, member cards with read status, question box with example queries, results with per-person
  reason and evidence, explicit no-match panel, rejected-names notice, MetaMask connect/disconnect
  + address/network badge, and a disclosure showing the exact messages sent.
- **Intended outcome:** A reviewer can exercise every behaviour without a wallet.
- **Verification:** `npm run build` (see `docs/harness-run-log.md` for the last run). A scripted
  browser smoke test was **not** run in this session; the UI was exercised through the API.

### T9 — Planned demo data: 8+ Sepolia names incl. one adversarial profile
- **Status:** `DONE` (planned data; **publishing not done, and not claimed**)
- **Description:** Nine planned community names with exact record values in
  `src/shared/demo-community.ts`, including one deliberately adversarial bio, plus the recorded
  expected-query cases.
- **Intended outcome:** Publishing and read-back can be done later with MetaMask, one record at a
  time, with no code change. **Nothing here claims the community is seeded.**
- **Verified state:** `npm run probe:community` reads Sepolia and reports no usable live records.
  With `ALLOW_SIMULATED_INDEX=true` the app answers from the same values, labelled
  `source: "simulated"` in every response and behind a banner in the UI.

### T10 — Deterministic local checks
- **Status:** `DONE`
- **Description:** Unit/API tests for validation, top-k bound, no-match branch, membership
  enforcement, timeout at the HTTP boundary, and the tracked-secret scanner (negative-tested).
- **Intended outcome:** Machine-checkable evidence for criteria 1–5, 7, 8.
- **Verification:** `npm test` → **135 tests across 7 files pass**; `npm run typecheck` clean;
  `npm run check:secrets` passes and was negative-tested with a synthetic `sk-…` key and a literal
  `LLM_API_KEY=<secret>` assignment.

### T11 — Docs: profile format, expected queries, acceptance checklist, README
- **Status:** `DONE`
- **Description:** `docs/profile-format.md`, `docs/expected-queries.md` (generated by
  `npm run record`), `docs/acceptance-checklist.md`, `docs/harness-run-log.md` (generated by
  `npm run harness:check`), `docs/problem-statement.md`, `README.md`.
- **Intended outcome:** Judge can read setup, flow, record keys, seeding steps, and honest status.
- **Note:** every document states the three things that are **not** claimed — the community is
  not published, no scored harness evaluation has been run, and no hosted provider was used.

### T12 — Session close-out: verification record + P3 handoff
- **Status:** `DONE`
- **Description:** Record exactly which checks were run and which are unverified, unresolved
  seeding/publish work, and the exact next step for P3 in a fresh session.
- **Done by:** the handoff table below, `docs/harness-run-log.md`, and the "Last verified run"
  sections in `README.md` and `docs/acceptance-checklist.md`.

### T13 — Scored harness evaluation + local/stress checks (first run)
- **Status:** `IN_PROGRESS`
- **Started:** 2026-10-04, fresh session. The deferral recorded in T12 ("runs after all three
  MVPs") is now lifted: P1, P2 and P3 all exist, so this is the session that runs it.
- **Description:** Run `npm run harness:check` for P2, execute the retrieved evaluator prompt
  inside this repo for all 8 scored criteria, run the project-prescribed local gates
  (`npm run check`, `npm run build`) and the documented recorded-query/stress checks
  (`npm run record`, `npm run probe:community`). Diagnose any genuine failure, make narrow
  fixes, rerun affected checks.
- **Constraints for this session:** no commit/push, no ENS writes or transactions, no root `.env`
  edit, no weakening of tests/gates/validation. ENS-dependent criteria that need published
  records are recorded NOT VERIFIED, never as passed. Ports 8788/8789 confirmed free before
  starting; no P2 UI server is started unless a documented check requires one.
- **Result:** `DONE` — all local gates green, both documented recorded/live checks run, official
  evaluator prompt fetched and executed. Full report with file:line evidence in
  `docs/harness-run-log.md` ("Official harness evaluation — executed 2026-10-04").

#### Observed results

| Check | Command | Result |
| --- | --- | --- |
| Chained gates | `npm run check` | **exit 0** — typecheck clean, 137 tests / 7 files, credential scan PASS (45 files), 22 doc references resolve |
| Repo-local harness | `npm run harness:check` | **exit 0** — typecheck 4.6 s, tests 6.7 s, scan 0.7 s, docs 0.4 s, build 6.5 s |
| Build | `npm run build` | PASS — 31 modules, 160.04 kB JS / 8.53 kB CSS |
| Recorded queries (stress) | `npm run record` | **9 passed, 0 failed, 0 errored**; retrieval reached 9/9 |
| Live chain probe | `npm run probe:community` | exit 0 — **no live member profile could be read** |
| Official evaluator prompt | `loops evaluate --event road-to-devcon-vii --problem community-people-finder` | exit 0, 9 758 chars, executed in-repo |

Ports 8788/8789 were confirmed **free** before starting and no P2 UI server was started;
`npm run record` boots the app in-process on an ephemeral port, so nothing bound a fixed port.
Nothing was committed, no ENS write or transaction was sent, root `.env` untouched.

#### Criterion state after this run (no official numeric verdict is claimed)

Criteria 1, 2, 3, 5, 6, 7, 8 are met in code, and criteria 1 and 5 were additionally observed
working in the live recorded run (`satoshi.eth` / `vitalik.eth` rejected as `not-in-candidates`;
two cases returned explicit no-match with `model used: no`).

**Criterion 4 is NOT VERIFIED / BLOCKED BY ENS SETUP.** The read path is correct
(`ens.ts:103-104` `getEnsText` via the Universal Resolver, `community.ts:188` roster re-read on
refresh) and is exercised by tests through the `readText` seam, but no live Sepolia record exists,
so the on-chain half cannot be claimed. A future user configures the community root, publishes
the records, and re-runs `npm run probe:community`.

#### Defects found and fixed in this run

**None.** No gate failed and no test needed changing, so nothing was patched. Two genuine
*alignment* gaps were found by executing the evaluator and are recorded as recommendations rather
than silently fixed, because both change the record schema the user will publish:

1. **No \`location\` field in the profile format.** The evaluator rewards a format capturing
   "skills, availability, location". \`profile.ts\` has \`name\` + \`com.peoplefinder.{role,skills,
   availability}\` + \`description\`; location survives only as free text in a bio, so the
   recorded "I just moved to Tokyo" query passes only because that word happens to appear in
   someone's bio. Fix is additive (one key, one optional fixture field, one doc row).
2. **No recorded query demonstrates the adversarial profile being excluded.** The property is
   proven by a probe line and a score penalty, not by a recorded case a judge can read.

#### Next step for a later session

Publish the nine community names, then re-run `npm run probe:community` and `npm run record` so
criteria 4 and 6 are verified against live records rather than the labelled simulated index.

---

## Current session handoff

### What is verified, and how

Everything in this table was observed on the development machine. Re-running the command is the
way to check it; nothing here is a claim about a scored evaluation.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| Tests | `npm run test` | 137 passed, 0 failed, 7 files |
| Credential scan | `npm run check:secrets` | 42 files read, no credential-shaped content, no secret file tracked |
| Doc references | `npm run check:docs` | 22 `file:line` references resolve |
| Production build | `npm run build` | `dist/web` built, 160 kB JS / 8.5 kB CSS |
| Local gates | `npm run harness:check` | green, written to `docs/harness-run-log.md` |
| Recorded queries | `npm run record` | **9 of 9 passed** with `qwen2.5:3b`; 9 of 9 also reachable with no model call |
| Live server | `npm start` | `/api/health` reports index ready, 9 members, roster source `simulated` |
| Browser bundle | `npm run dev:web` | app shell and `main.tsx` served, `/api` proxied to `8788`, a live `POST /api/find` answered |

Two changes made in this final pass, both from real failures rather than review:

1. `SUSPICIOUS_SCORE_PENALTY` was moved out of the relevance score into a separate ordering score.
   Applying it to `score` also moved the profile across the `minScore` floor, which silently turned
   "ranked lower" into "excluded" — a worse failure than the one the penalty was meant to prevent.
   `score` now measures relevance and gates admission; the flag only changes position. Two tests
   cover both halves of that decision.
2. The compromised-model API test no longer asserts a match count. It asserts what the membership
   check actually guarantees: nothing outside the candidate set is displayed, and the rejections
   are reported. The old assertion passed for the wrong reason — it depended on the adversarial
   profile being ranked first, so that its second mention became a duplicate.

### What is deliberately not verified

- **No scored Agent Harness evaluation has been run.** It stays deferred until all three MVPs
  exist. `npm run harness:check` computes no score and is labelled that way in its own output.
- **The demo community is not published.** No ENS record exists for any of the nine planned names,
  so every recorded run reads the labelled simulated index, not Sepolia.
- **No hosted model provider was used.** The recorded run is a local `qwen2.5:3b` through Ollama.
  `qwen3:4b` was tried first and could not answer at all: it consumed the entire token budget on
  private reasoning and returned no JSON. That is why `LLM_MAX_TOKENS` and the empty-answer
  diagnostics in `src/server/llm.ts` exist.
- **`npm install` reports five audit findings** (three moderate, one high, one critical) in the
  transitive tree. Not force-fixed, because that would change versions across the `viem` and
  `zod` trees the app depends on.

### Unresolved, and the exact next step

Nothing is broken. The remaining work is publishing and scoring, both of which need a decision or
a credential that this session did not have:

1. **Publish the demo community** (needs a funded Sepolia wallet and a decision about whose keys
   sign). `docs/profile-format.md` documents every record key, bound and the publishing order;
   `npm run probe:community` reports exactly what exists on chain right now.
2. **Re-record after publishing** so `docs/expected-queries.md` describes live Sepolia records
   instead of the fixture set. The command does not change: `npm run record`.
3. **Run the scored evaluation** once all three MVPs exist, then record the result honestly,
   criterion by criterion, including any criterion it fails.

### Exact first step for P3, in a fresh session

1. `cd N:\dev8\p3` and read `p3.md` plus that directory's `action.md` before writing anything.
2. Run `npm install` and the directory's own `npm run check` first, so the starting state is
   known rather than assumed.
3. Treat P2 as read-only reference. Two things are worth copying deliberately: the
   `file:line`-backed claims in `docs/acceptance-checklist.md`, and the rule that a generated
   document must say which model, which index source and which machine produced it.
---

## T14 — Release readiness review (2026-10-04, late session) `DONE`

**Scope:** confirm each of the 8 scored checks in `p2.md` against observed output, then prepare the
repository. Deliberately **not** repeated: the long full stress process, `npm run record`,
`npm run probe:community`, the browser-bundle check and the manual UI review — all were already
observed in the previous session and are recorded in `docs/harness-run-log.md` and
`docs/expected-queries.md`, and none of them gates the commit.

### Local gates — observed

| Command | Observed result |
| --- | --- |
| `npm run check` | **exit 0** — `tsc --noEmit` clean; **137 passed / 137** across 7 files (5.90 s); credential scan PASS (45 text files, ignore rules verified, `tracked .env files: none`); `checked 27 reference(s) across 7 doc file(s)` → PASS |
| `npm run build` | **PASS** — built in 4.93 s, `p2/dist/web` 160.04 kB JS / 8.53 kB CSS |

### Per-criterion state

| # | Criterion | State |
| --- | --- | --- |
| 1 | Every person checked against retrieved candidates | Met — `src/shared/model-output.ts:165`, `:118`; `satoshi.eth` / `vitalik.eth` observed rejected |
| 2 | Bounded candidate count sent to the model | Met — `src/shared/retrieval.ts:239`, `:45`, plus `CandidateLimitError` at `src/server/llm.ts:161` |
| 3 | Profile text never in the system prompt | Met — `buildSystemMessage()` takes no arguments, `src/shared/prompt.ts:69` |
| 4 | Index built from ENS text record reads | **Met in code / on-chain half NOT VERIFIED** — `src/server/ens.ts:126`, `:207`, `src/server/community.ts:152` |
| 5 | Explicit no-match on an empty result | Met and observed — two recorded queries returned no-match with `model used: no` |
| 6 | Recorded queries state expected members | Met and observed — `src/shared/expected-queries.json`, 9 cases, `npm run record` 9/9 |
| 7 | Explicit timeout on the model request | Met — `src/server/llm.ts:180` |
| 8 | No credential in a tracked file | Met — scan PASS |

**7 of 8 pass outright; check 4's on-chain half is BLOCKED BY ENS SETUP.**

### Defects

**None.** No gate failed, so nothing was patched and no test was changed.

### T15 — submission report `DONE`

`docs/submission-report.md`: per-criterion observed results with `file:line`, every command run, and
an explicit "still NOT VERIFIED" section.

### Still NOT VERIFIED / BLOCKED BY ENS SETUP

- **"Seed a test community on Sepolia: at least 8 ENS names … with profile text records."** Not done.
  All nine planned `*.tokyobuilders.eth` names are unpublished, so every run reads the clearly
  labelled **simulated** index and responses report `rosterSource: simulated`.
- The brief's acceptance criterion is therefore **PARTIAL**: two real members with a reason each are
  returned and invented/non-member names are provably rejected, but the community is not on chain.
- No official numeric score is claimed: `loops evaluate` returns an evaluator prompt, not a verdict.

No ENS write, no transaction, root `.env` untouched, no credential printed, no gate weakened.
