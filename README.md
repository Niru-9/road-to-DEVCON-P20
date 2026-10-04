# Who In Here Can Help Me?

A people-finder for an ENS-based builder community. Members ask in plain language — *"who can
mentor me in Rust this month?"* — and get back **real people from the community**, each with a
reason and the record evidence behind it, or an honest **"nobody fits"**.

Every profile is read live from ENS text records on Sepolia. Anyone can write anything in their
own bio, so retrieved text is treated as untrusted input at a trust boundary: it is bounded,
sanitised, flagged when it looks like an instruction, and passed to the model as *data*, never
as instructions. A person the model invents — or a real person who was not a candidate — can
never be displayed.

> **Status:** the app, tests, record format, recorded queries and scripts are complete.
> **The test community is not published on Sepolia yet**, so a run today uses a clearly-labelled
> simulated index. **The scored Agent Harness evaluation has not been run** — it is deferred until
> all three MVPs exist. See [`docs/acceptance-checklist.md`](./docs/acceptance-checklist.md) for
> the per-criterion status, including what is *not* claimed.

---

## Quick start

```bash
npm install
Copy-Item .env.example .env      # bash/mac: cp .env.example .env
npm run dev                      # API on :8788, UI on :5174
```

`npm run dev` starts the Express server and the Vite dev server together. Open the UI, press
**Refresh community**, and ask a question. No wallet, no key and no MetaMask are needed to use
any of it: ENS reads are `eth_call`, so looking up profiles is free and read-only.

For a production build:

```bash
npm run build                    # bundles the UI into dist/web
npm start                        # serves API + UI from one process
```

### Configuration

Everything comes from the environment; nothing is hardcoded at a call site. `.env.example`
documents each value. The ones worth knowing:

| Variable | Default | What it does |
| --- | --- | --- |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | — | Any OpenAI-compatible provider. Local Ollama needs no key. |
| `LLM_TIMEOUT_MS` | `20000` | Explicit per-request timeout. **Required bound.** |
| `LLM_MAX_TOKENS` | `600` | Explicit bound on the answer, complementing `topK` on the input. |
| `SEPOLIA_RPC_URL`, `RPC_TIMEOUT_MS` | public endpoint | Read-only Sepolia access. |
| `COMMUNITY_ROOT` | `tokyobuilders.eth` | Root whose `com.peoplefinder.members` record is the roster. |
| `COMMUNITY_MEMBERS` | empty | Fallback roster, used **only** when the root record is unreadable. |
| `COMMUNITY_MEMBERS_MAX` | `12` | Ceiling on members read per refresh. |
| `TOP_K_CANDIDATES` | `5` | Maximum profiles that can ever enter a prompt. |
| `MIN_CANDIDATE_SCORE` | `1` | Relevance floor; below it, no candidate at all. |
| `ALLOW_SIMULATED_INDEX` | `true` | Allow the labelled local fixture set when live reads return nothing. |
| `PORT` | `8788` | Server port. In development this must stay `8788`, because `vite.config.ts` proxies `/api` to it. |

Bad configuration fails at boot with a message naming the variable and the accepted values,
rather than at the first request.

---

## How a question is answered

```
"who can help me with Rust this month?"
        │
        ▼
1. ENS index      roster read from the community root's com.peoplefinder.members record,
                  then each member's name / role / skills / availability / description
        │         → bounded, sanitised, availability allowlisted, injection-flagged
        ▼
2. Retrieval      deterministic lexical scoring, field-weighted (skills > role > bio > name),
                  inflections folded; everything below MIN_CANDIDATE_SCORE dropped, then
                  sliced to TOP_K_CANDIDATES
        │
        ▼
3. Gate           a question about someone's time excludes members whose availability is
                  `unavailable` — they are remembered as named near-misses
        │
        ├── zero candidates ──► explicit no-match, **no model request at all**
        │
        ▼
4. Model call     system message is app-authored and takes NO arguments; the question and the
                  bounded candidate data travel as two separate user messages
        │
        ▼
5. Membership     every name the model returned is re-normalized and must be in the retrieved
                  candidate set; display name, evidence and availability are copied from the
                  candidate's own records, never from the model
        │
        ▼
6. Answer         people + reason + record evidence, or a no-match panel that says why
```

Retrieval is deterministic: the same question against the same index returns the same
candidates, so the recorded queries in [`docs/expected-queries.md`](./docs/expected-queries.md)
are reproducible.

---

## Honest answers, not helpful ones

Two branches return "nobody fits" **without asking the model at all**, because a model asked to
find someone will usually find someone:

- **Nobody scored above the relevance floor.** No candidates, so the question is answered
  directly and `model.skippedReason` says the model was never called.
- **Every candidate was unavailable.** The excluded people are named in the response as
  near-misses, so "nobody is free this week" is explainable rather than bare.

There is a third: if the model is called and says no match, that is believed, with its reason.

A provider failure is never dressed up as an answer. A timeout, a 500 or an unreachable host
becomes an error response — never an invented person and never an empty list.

---

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Chain id, roster key, bounds in force, index status. Never leaks the key. |
| `GET /api/community` | Current index: members, per-record read status, warnings, `source`. |
| `POST /api/community/refresh` | Re-read the roster and every member from Sepolia. |
| `POST /api/find` | `{ question, refreshFirst? }` → matches, reasons, evidence, no-match. |
| `GET /api/examples` | Example questions taken from the recorded dataset. |

`refreshFirst: true` refreshes the index before answering, so a member who just edited their
profile record is not told they do not exist.

---

## Safety properties, and where each one lives

| Property | Where |
| --- | --- |
| Hallucinated or non-candidate names rejected before display | `src/shared/model-output.ts` |
| Prompt size bounded, and re-checked at the HTTP boundary | `src/shared/retrieval.ts`, `src/server/llm.ts` |
| System prompt is app-authored and argument-free | `src/shared/prompt.ts` |
| Records bounded, sanitised, availability allowlisted, injection-flagged | `src/shared/profile.ts` |
| Explicit model timeout, bounded retries, bounded output | `src/server/llm.ts`, `src/server/config.ts` |
| A flagged profile is ranked below honest matches, without being hidden | `src/shared/retrieval.ts` |
| No wallet, no signing key, no credential in any tracked file | `.env.example`, `scripts/scan-secrets.mjs` |
| Every code reference in these docs still resolves | `scripts/check-doc-references.mjs` |

The adversarial member in the planned community has a bio containing instructions to a model.
It is flagged, shown as flagged, and passed to the model as data. Two recorded queries assert
that `satoshi.eth` and `vitalik.eth` — real, famous names written into that bio — never appear
as results.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `dev:server` / `dev:web` | Run both halves, or one of them with watch. |
| `npm run build` / `start` | Production bundle, and serve API + UI from one process. |
| `npm test` | The full suite. |
| `npm run check` | typecheck + tests + secret scan + doc-reference check. |
| `npm run harness:check` | Repo-local gates + build + required-documents check. **Computes no score.** |
| `npm run check:secrets` | Fail on any credential-shaped content in a non-ignored file. |
| `npm run check:docs` | Fail on any `file:line` reference in the docs that no longer resolves. |
| `npm run probe:community` | Read-only Sepolia probe: roster, per-record status, live vs simulated. `--retrieval` prints the model-free candidate ranking. |
| `npm run record` | Run the recorded queries against a live app and write `docs/expected-queries.md`. |

---

## Last verified run

Observed on the development machine, not asserted. `docs/harness-run-log.md` and
`docs/expected-queries.md` are the generated records.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run test` | 137 passed, 0 failed, 7 files |
| `npm run check:secrets` | 42 files read, no credential-shaped content, no secret file tracked |
| `npm run check:docs` | 22 `file:line` references in the docs all resolve |
| `npm run build` | built: `dist/web` 160 kB JS, 8.5 kB CSS |
| `npm run harness:check` | green |
| `npm run record` | 9 of 9 cases passed with `qwen2.5:3b`; 9 of 9 also reachable with no model call |
| `npm start` + `curl /api/health` | index ready, 9 members, roster source `simulated`, bounds reported |
| `npm run dev:web` | app shell and `main.tsx` served, `/api` proxied to `8788`, live `POST /api/find` answered |

Two honest caveats on that table. The recorded run used the **labelled simulated index**, not
published Sepolia records, because the demo community has not been published. And
`qwen2.5:3b` is a 3 B local model: it answered all nine cases, but an earlier `qwen3:4b`
configuration could not, because it spent the whole token budget on private reasoning and
returned no JSON. The token bound and the diagnostics in `src/server/llm.ts` exist because that
failure was real.

---

## Documentation

| File | Contents |
| --- | --- |
| [`docs/problem-statement.md`](./docs/problem-statement.md) | The brief, restated, and the scored criteria mapped to files. |
| [`docs/profile-format.md`](./docs/profile-format.md) | ENS record keys, every bound, sanitisation rules, the availability allowlist, how to publish your own profile. |
| [`docs/expected-queries.md`](./docs/expected-queries.md) | The nine recorded queries, expected members, and one real run. **Generated** by `npm run record`. |
| [`docs/acceptance-checklist.md`](./docs/acceptance-checklist.md) | Per-criterion status, with the evidence and the three things not claimed. |
| [`docs/harness-run-log.md`](./docs/harness-run-log.md) | The last repo-local gate run. **Generated** by `npm run harness:check`. |

---

## Publishing the demo community

Nothing has been written to Sepolia. To publish it, for each of the nine names in
`src/shared/demo-community.ts`, add the text records listed in
[`docs/profile-format.md`](./docs/profile-format.md) using the member's own wallet on Sepolia,
then add the names to the community root's `com.peoplefinder.members` record.

Read back what the app sees, at any point, without publishing anything:

```bash
npm run probe:community
npm run probe:community -- --profile mei.tokyobuilders.eth
```

`ALLOW_SIMULATED_INDEX=false` makes live ENS data the only possible source, which is the setting
to use when checking a partially-seeded community.

---

## Stack

TypeScript, Express, React + Vite, viem (Sepolia ENS via the Universal Resolver), zod, Vitest,
and any OpenAI-compatible model endpoint. No wallet library, no signing code, no SDK.