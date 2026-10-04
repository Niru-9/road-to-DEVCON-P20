# Community profile record format

Every field this app shows a user comes from a **public ENS text record**. Anyone can put
anything in their own records, including text written to hijack a language model. The format
below is therefore a *trust-boundary contract*: it exists so that a hostile or sloppy record
can be bounded, sanitised, validated and labelled before it is displayed or sent to a model.

The rules are implemented in `src/shared/profile.ts`; this document describes them so a member
can publish their own profile without reading the code.

---

## 1. Record keys

Two keys are standard ENSIP-5 *global* keys, so they render in any ENS-aware wallet:

| Field        | ENS record key | Required | Meaning                                        |
| ------------ | -------------- | -------- | ---------------------------------------------- |
| Display name | `name`         | no       | The name shown next to the ENS name            |
| Bio          | `description`  | no       | One or two sentences about the person          |

Three keys are this app's own, namespaced under `com.peoplefinder.*`, which is the ENSIP-5
convention for a record format you define yourself and which cannot collide with anyone else:

| Field         | ENS record key                       | Required | Meaning                                              |
| ------------- | ------------------------------------ | -------- | ---------------------------------------------------- |
| Role          | `com.peoplefinder.role`              | no       | One short job title, e.g. `Protocol engineer`        |
| Skills        | `com.peoplefinder.skills`            | no       | Comma-separated list, e.g. `rust,node,devops`         |
| Availability  | `com.peoplefinder.availability`      | no       | `open`, `limited` or `unavailable`                    |

### The roster

The community's member list is itself a record, on the community root name:

| Key                              | Meaning                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `com.peoplefinder.members`       | Comma-, semicolon- or newline-separated member ENS names |

Membership is therefore **discovered from a live ENS read of the root**, not from a list
compiled into the app. Nothing can join the community by editing the code.

---

## 2. Bounds

Nothing read from chain is allowed to grow without limit.

| Bound                          | Value | Why                                                  |
| ------------------------------ | ----- | ---------------------------------------------------- |
| `name`                         | 60 chars  | A display name is short; a longer one is not a name |
| `com.peoplefinder.role`        | 80 chars  | A job title                                          |
| `description`                  | 280 chars | A couple of sentences                                |
| `com.peoplefinder.skills`      | 200 chars | ~12 skill names                                      |
| `com.peoplefinder.availability`| 24 chars  | It is a closed value, not prose                      |
| Skill tokens                   | 12 max, 32 chars each | A member cannot flood the prompt    |
| Roster entries per read        | 200 max | Bound before normalisation                            |
| Members indexed per refresh     | `COMMUNITY_MEMBERS_MAX`, 1–50, default 12 | Bound on RPC calls |
| Search questions               | HTTP body limit 32 kB | Bound before parsing                  |
| Candidates into the prompt     | `TOP_K_CANDIDATES`, default 5 | Scored criterion 2       |
| Model tokens out               | `LLM_MAX_TOKENS`, default 600 | The answer is bounded too |

Anything cut is **reported, not silently swallowed**: an over-long value is truncated with a
visible `…[truncated]` marker and the profile carries an `invisible-characters-stripped`,
`truncated`, `too-many-skills`, `skill-token-truncated` or `empty-after-sanitisation` warning
that the UI shows.

---

## 3. Sanitisation

Text read from a record is public and owner-controlled, so before anything downstream sees it:

1. **NFC normalisation** — so the same visible text compares equal every time.
2. **Invisible characters removed** — C0/C1 control characters, `DEL`, zero-width characters
   (`U+200B`–`U+200F`), line/paragraph separators, bidirectional overrides (`U+202A`–`U+202E`)
   and `U+FEFF`. These render as nothing to a human but can hide text from a reviewer who only
   sees one direction of a string.
3. **Whitespace collapsed** — runs of spaces collapse to one; at most two consecutive newlines
   survive in a bio. Tab, newline and carriage return *do* survive, because a member typing a
   bio over several lines is not an attack.
4. **Otherwise verbatim.** Text is never "cleaned up" into something the app likes, because
   that would make the app describe a person inaccurately.

---

## 4. Availability is a closed allowlist

`availability` is what makes "who is free right now?" answerable without a model guessing, so it
is never free text.

| Canonical value   | Accepted on-chain spellings                                  |
| ----------------- | ------------------------------------------------------------ |
| `open`            | `open`, `available`, `free`, `available now`, `yes`           |
| `limited`         | `limited`, `partial`, `limited time`, `busy`                  |
| `unavailable`     | `unavailable`, `not available`, `none`, `no`                  |

Anything else — including a record listing several values at once — is **rejected** and treated
as *unknown*, with an `availability-not-recognised` warning. An unset or unrecognised value is
never guessed at: the app simply does not claim to know, and a question that asks about someone's
time does not exclude them.

---

## 5. Instruction-like text is flagged, never obeyed

`src/shared/profile.ts` matches a list of instruction-shaped patterns (`ignore all previous
instructions`, `system prompt`, `you are now`, `new instructions:`, `do not mention …`,
`recommend me`, and similar) against every human-readable field *after* sanitisation, so the
check cannot be evaded with invisible characters.

A profile that matches is:

- marked `suspicious: true` in the index and in `/api/community`,
- labelled in the UI, with the warning text shown to the user,
- passed to the model only as **data**, in a message that the app-authored system prompt tells
  the model to treat as untrusted input,
- never excluded — flagging is not the same as silencing a real member.

Detection exists to **label** a record, not to launder it. Nothing in this app executes a record.

---

## 6. Publishing your own profile

Everything is a text record, so it can be published with any ENS-aware wallet. **This app never
asks for, accepts, stores or transmits a private key or seed phrase** — it has no signing code
at all, and there is deliberately no key entry in `.env.example`.

For Sepolia, with MetaMask switched to the *Sepolia* network:

1. Go to the app's name in your wallet, open **Edit records**.
2. Add `name`, `description`, `com.peoplefinder.role`, `com.peoplefinder.skills` and
   `com.peoplefinder.availability` with the values above.
3. Save. The wallet signs; the app only ever reads.
4. To join a community, add your ENS name to the community root's `com.peoplefinder.members`
   record (requires control of the root name).

Reading back what the app sees:

```bash
npm run probe:community              # roster + per-record read status
npm run probe:community -- --profile <name>.eth
```

---

## 7. The planned demo community

`tokyobuilders.eth` with nine members (Aiko, Daichi, Mei, Kenji, Ravi, Sora, Yuki, Nadia, and an
adversarial Mika) is defined in `src/shared/demo-community.ts` as the exact values to publish.

**It is not published.** No record has been written for any of these names. Until it is, the app
reports that it read nothing and, only if `ALLOW_SIMULATED_INDEX=true`, falls back to the same
values labelled `source: "simulated"` in every response and behind a banner in the UI.