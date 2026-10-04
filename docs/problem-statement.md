# Problem statement — Who In Here Can Help Me?

*Restated in this repository so the build can be read against its brief. The authoritative
brief is `p2.md` (Road to Devcon VII, problem `community-people-finder`).*

## The situation

Kenji runs a builder community in Tokyo. Every member has an ENS name with a short profile: a
bio, what they are good at, whether they have time to help. New members keep posting the same
question in the group chat — *"Is anyone here good at Rust and free to mentor this month?"*

Nobody can read three hundred profiles by hand, and the last chatbot someone tried confidently
recommended a person who does not exist.

## What Kenji wants

Members ask in plain language and get back **real people from the community**, with a reason for
each one, and an honest *"nobody fits"* when that is the truth.

## What to do

1. Seed a test community on Sepolia: at least 8 ENS names, ideally subnames of one parent, with
   profile text records. At least one bio deliberately adversarial.
2. Build an index from those live ENS records, with a way to refresh it.
3. Let a member ask a question in natural language and get back matching people, why each one
   matches, and their ENS name.
4. Handle the case where nobody matches.
5. Record example cases, and a set of test queries with the members they are expected to return.

## The acceptance criterion in one sentence

> A new member asks who can mentor them in Rust this month and gets two real community members
> with a reason for each, **or** a straight answer that nobody fits.

The "or" is the hard half. A system that always finds somebody has failed the brief; so has one
that invents somebody.

## Scored criteria (8 cases, 80 points)

Each is read off the repo, not run by a grader.

| # | Criterion | Points | Where this repo answers it |
| --- | --- | --- | --- |
| 1 | Every person in the answer is checked against the retrieved candidates | 22 | `src/shared/model-output.ts` |
| 2 | Only a bounded number of candidates is sent to the model | 10 | `src/shared/retrieval.ts`, `src/server/llm.ts` |
| 3 | Profile text is never interpolated into the system prompt | 12 | `src/shared/prompt.ts` |
| 4 | The index is built from ENS text record reads | 8 | `src/server/ens.ts`, `src/server/community.ts` |
| 5 | An empty match produces an explicit no-match response | 8 | `src/server/find.ts` |
| 6 | Recorded test queries state their expected members | 8 | `src/shared/expected-queries.json` |
| 7 | The model request has an explicit timeout | 6 | `src/server/llm.ts`, `src/server/config.ts` |
| 8 | No credential appears in any tracked file | 6 | `scripts/scan-secrets.mjs` |

Per-criterion status with the evidence for each claim is in
[`docs/acceptance-checklist.md`](./acceptance-checklist.md).

## Suggested stack, and what was actually used

| Suggested | Used | Note |
| --- | --- | --- |
| viem | yes | `resolveName` / Universal Resolver for Sepolia reads |
| ENS on Sepolia | yes | chain id `11155111` |
| Any OpenAI-compatible LLM | yes | endpoint and model id both come from configuration |
| Zod or JSON Schema | yes | `zod` for config, query validation and model output |
| Any web framework | yes | Express + a React/Vite single screen |

## Honest status of this repository

- The app, its tests, the record format, the recorded queries and the operational scripts are
  complete.
- **The test community is not published.** `tokyobuilders.eth` has no records on Sepolia, so a
  run today uses the clearly-labelled simulated index. The exact values to publish are in
  `src/shared/demo-community.ts`.
- **The scored Agent Harness evaluation has not been run.** It is deferred until all three MVPs
  exist. `npm run harness:check` is a repo-local gate runner and computes no score.