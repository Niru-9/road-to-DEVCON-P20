# Submission report — P2 "Who In Here Can Help Me?" (Community People Finder)

Prepared from observed command output only. Every row is backed by a command in
[Checks actually run](#checks-actually-run). No official numeric score is claimed: `loops evaluate`
returns an evaluator *prompt*, not a verdict, and this repository's `npm run harness:check` states
that it is local and computes no score.

## Target repository

- Project folder: `p2/`
- Remote: `https://github.com/Niru-9/road-to-DEVCON-P20`
- Remote state when checked: **empty** (`git ls-remote` → 0 refs), so no remote history is at risk.

## The eight scored checks, and what was actually observed

| # | Check (`p2.md`) | Observed | Evidence |
| --- | --- | --- | --- |
| 1 | Every person in the answer is checked against the retrieved candidates (22) | **PASS** | `enforceCandidateMembership()` — `src/shared/model-output.ts:165` — re-normalizes every name the model emitted (ENSIP-15) and looks it up in the retrieved candidate set; a name outside it is rejected as `not-in-candidates` and never displayed. `parseModelAnswer()` throws rather than return an unchecked name — `src/shared/model-output.ts:118`. Observed live in the recorded run: `satoshi.eth` and `vitalik.eth` were both rejected. Tests: `src/shared/model-output.test.ts` (17 tests) plus `src/server/api.test.ts` — *drops invented and non-member names when the model has been compromised*. |
| 2 | Only a bounded number of candidates is sent to the model (10) | **PASS** | `retrieveCandidates()` slices to `topK` after dropping everything below `minScore` — `src/shared/retrieval.ts:239`; `topK` is itself clamped to `MAX_TOP_K = 20` — `src/shared/retrieval.ts:45`. Independent second guard at the HTTP boundary: `CandidateLimitError` before any request — `src/server/llm.ts:161`. Tests: *never returns more candidates than top-k, even with a huge matching community*, *caps an oversized top-k instead of trusting it*, *drops everything below the relevance floor*. |
| 3 | Profile text is never interpolated into the system prompt (12) | **PASS** | `buildSystemMessage()` takes **no arguments** — `src/shared/prompt.ts:69` — so there is no parameter through which profile text could arrive. `buildChatMessages()` sends the app-authored system message, the question and a separate candidate-data message — `src/shared/prompt.ts:129`. Belt-and-braces: `findProfileLeakage()` — `src/shared/prompt.ts:148` — throws `ProfileLeakageError` at `src/server/llm.ts:168`. Tests: *the system message takes no arguments*, *no profile text reaches the system message*. |
| 4 | The index is built from ENS text record reads (8) | **PASS in code / on-chain half NOT VERIFIED** | `readProfileRecords()` — `src/server/ens.ts:126` — reads each profile key through the Universal Resolver on Sepolia (chain `11155111`) with a per-call RPC timeout; the member roster is itself a record read, `readRosterRecord()` — `src/server/ens.ts:207` — and `CommunityIndex.refresh()` — `src/server/community.ts:152` — re-reads roster and profiles. Exercised by tests through the `readText` seam (*reads the roster and every profile from ENS when the chain answers*). **No live Sepolia record exists**, so the on-chain half cannot be claimed. See [Still NOT VERIFIED](#still-not-verified--blocked-by-ens-setup). |
| 5 | An empty match produces an explicit no-match response (8) | **PASS, and observed in a live recorded run** | If retrieval returns nothing above threshold the request returns an explicit no-match response **and the model is never called**. Two of the nine recorded queries returned explicit no-match with `model used: no`. Tests in `src/server/api.test.ts` — *POST /api/find — explicit no-match*; *names unavailable people as excluded rather than hiding them*. |
| 6 | Recorded test queries state their expected members (8) | **PASS, and observed** | `src/shared/expected-queries.json` — 9 cases, each with `expect`, `mustInclude`, `mayInclude`, `mustNotInclude` and a `why`; first case `rust-mentor-this-month` must include `aiko.tokyobuilders.eth` and `daichi.tokyobuilders.eth`. Generated view in `docs/expected-queries.md`. `npm run record` → **9 passed, 0 failed, 0 errored**; retrieval reached 9/9. Suite `src/shared/expected-queries.test.ts` (18 tests) validates the dataset itself. |
| 7 | The model request has an explicit timeout (6) | **PASS** | Per-attempt `AbortController` — `src/server/llm.ts:180` — bounded by `config.llmTimeoutMs`, cleared in `finally`, with bounded retries. Test: *surfaces a model failure as an error rather than as an invented person* (1 987 ms, real timeout path). |
| 8 | No credential appears in any tracked file (6) | **PASS** | `npm run check:secrets` → `PASS: no credential-shaped content in tracked files, and no secret file is tracked`, 45 text files read, ignore rules verified (`.env`, `.env.local`, `secrets.json`, `wallet.json`, `id.pem`), `tracked .env files: none`. |

**7 of 8 checks pass outright; check 4 passes in code with its on-chain half unverified.**

## Checks actually run

| Check | Command | Observed result |
| --- | --- | --- |
| Typecheck + tests + secret scan + doc refs | `npm run check` | **exit 0** — `tsc --noEmit` clean; **137 passed / 137** across 7 files (5.90 s); credential scan PASS (45 files, no tracked `.env`); `checked 27 reference(s) across 7 doc file(s)` → PASS |
| Production build | `npm run build` | **PASS** — built in 4.93 s, `dist/web` 160.04 kB JS / 8.53 kB CSS |

Not re-run this session, because nothing in the release path depended on them and they were
already observed in the previous session's recorded runs (see `docs/harness-run-log.md` and
`docs/expected-queries.md`): `npm run harness:check` (green: typecheck, tests, scan, docs, build),
`npm run record` (9/9), `npm run probe:community` (no live member profile readable — the expected
result while nothing is published), the browser-bundle check, and the manual UI review. The
long full stress process is not part of this project's documented gates and was deliberately not
repeated.

## Defects

**None found in this session.** No gate failed, so nothing was patched and no test was changed.

Two *alignment* gaps were found by executing the official evaluator prompt in the previous session
and are recorded as recommendations rather than silently fixed, because both change the record
schema the user will publish:

1. No `location` field in the profile format — location survives only as free text in a bio.
2. No recorded query demonstrates the adversarial profile being excluded; the property is proven by
   a probe line and a score penalty, not by a recorded case a judge can read.

## Still NOT VERIFIED — blocked by ENS setup

| Requirement | Status | Why |
| --- | --- | --- |
| "Seed a test community on Sepolia: at least 8 ENS names … with profile text records. Make at least one bio deliberately adversarial." | **NOT VERIFIED / BLOCKED BY ENS SETUP** | No ENS record is published for any of the nine planned `*.tokyobuilders.eth` names, so every run reads the clearly-labelled **simulated** index. Publishing needs a funded Sepolia wallet and a signing decision that this session did not have. |
| Check 4's on-chain half (index built from real ENS reads) | **NOT VERIFIED** | Read path is correct and tested through a seam, but no live record exists to read back. `npm run probe:community` reports exactly what is on chain right now. |
| Acceptance criterion: a new member asks who can mentor them in Rust this month and gets two real members | **PARTIAL** | Two real community members with a stated reason are returned, and invented/non-member names are provably rejected — but "real" here means from the simulated roster, not from Sepolia. |
| Official scored evaluation / numeric points | **not claimed** | `loops evaluate --event road-to-devcon-vii --problem community-people-finder` returns an evaluator prompt, not a verdict. |

No ENS write and no transaction was sent. The root `.env` was not touched. No credential was
printed, requested or written to a tracked file.

## Status

**Ready for repository preparation**, with the honest limitation that the community is not yet on
Sepolia: the app, the index pipeline, the grounding guarantees, the recorded queries and all local
gates are green, and both the README and this report state that the seeded community is simulated
rather than published.

Known, deliberately unfixed: `npm install` reports five audit findings (three moderate, one high,
one critical) in the transitive tree. Not force-fixed, because that moves versions across the `viem`
and `zod` trees the app depends on. The recorded run uses a local `qwen2.5:3b` through Ollama; no
hosted provider was exercised.
