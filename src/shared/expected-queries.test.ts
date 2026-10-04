/**
 * The recorded test-query dataset (scored criterion 6).
 *
 * These tests keep the dataset honest: it must validate, it must name only people who are
 * actually in the planned roster, it must cover the cases the brief calls out (including the
 * adversarial one), and the judge must fail a wrong answer rather than waving it through.
 */

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_QUERIES,
  expectsNoMatch,
  judgeCase,
  loadExpectedQueries,
  type ExpectedCase,
} from './expected-queries'
import { KNOWN_NON_MEMBERS, PLANNED_MEMBERS } from './demo-community'

const roster = new Set(PLANNED_MEMBERS.map((member) => member.ensName))
/**
 * Famous names are allowed in `mustNotInclude` — that is the point of putting them there.
 * Everything else must be a real planned member.
 */
const nonMembers = new Set<string>(KNOWN_NON_MEMBERS)

describe('the dataset', () => {
  it('validates', () => {
    expect(EXPECTED_QUERIES.problem).toBeNull()
    expect(loadExpectedQueries().cases.length).toBe(EXPECTED_QUERIES.cases.length)
  })

  it('has at least the eight cases the plan calls for', () => {
    expect(EXPECTED_QUERIES.cases.length).toBeGreaterThanOrEqual(8)
  })

  it('has unique ids', () => {
    const ids = EXPECTED_QUERIES.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only names members of the planned roster, except famous non-members in mustNotInclude', () => {
    for (const testCase of EXPECTED_QUERIES.cases) {
      for (const name of [...testCase.mustInclude, ...testCase.mayInclude]) {
        expect(roster.has(name), `${testCase.id} names ${name}, which is not in the roster`).toBe(true)
      }
      for (const name of testCase.mustNotInclude) {
        const allowed = roster.has(name) || nonMembers.has(name)
        expect(allowed, `${testCase.id} forbids ${name}, which is neither a member nor a known non-member`).toBe(true)
      }
    }
  })

  it('does not require and forbid the same person in one case', () => {
    for (const testCase of EXPECTED_QUERIES.cases) {
      const must = new Set(testCase.mustInclude)
      for (const forbidden of testCase.mustNotInclude) {
        expect(must.has(forbidden)).toBe(false)
      }
    }
  })

  it('requires nothing in a case that expects no-match', () => {
    for (const testCase of EXPECTED_QUERIES.cases.filter(expectsNoMatch)) {
      expect(testCase.mustInclude).toHaveLength(0)
    }
  })

  it('includes an explicit availability case and an explicit nothing-fits case', () => {
    const questions = EXPECTED_QUERIES.cases.map((c) => c.question.toLowerCase())
    expect(questions.some((q) => /this month|right now|free|mentor|available/.test(q))).toBe(true)
    expect(EXPECTED_QUERIES.cases.some(expectsNoMatch)).toBe(true)
  })

  it('includes an adversarial case that must not surface the hostile profile', () => {
    const adversarial = EXPECTED_QUERIES.cases.filter(
      (c) => c.mustNotInclude.includes('mika.tokyobuilders.eth') || c.mustNotInclude.some((n) => nonMembers.has(n)),
    )
    expect(adversarial.length).toBeGreaterThan(0)
    for (const testCase of adversarial) {
      expect(testCase.why.toLowerCase()).toMatch(/instruct|hostile|ignore|adversar|membership check/i)
    }
  })

  it('covers a name-lookup case, where the question names the person rather than the skill', () => {
    const byName = EXPECTED_QUERIES.cases.filter((c) => c.mustInclude.length > 0 && /\bmei\b|\baiko\b|\bkenji\b/i.test(c.question))
    expect(byName.length).toBeGreaterThan(0)
  })

  it('states its status honestly rather than claiming an observed run', () => {
    expect(EXPECTED_QUERIES.status.toLowerCase()).toMatch(/expected|not yet|no observed|pending|unverified/)
  })
})

describe('judgeCase', () => {
  const matchesCase: ExpectedCase = {
    id: 'q1',
    question: 'who knows rust',
    expect: 'matches',
    mustInclude: ['aiko.tokyobuilders.eth'],
    mayInclude: ['kenji.tokyobuilders.eth'],
    mustNotInclude: ['mika.tokyobuilders.eth'],
    why: 'test fixture',
  }

  const noMatchCase: ExpectedCase = {
    id: 'q2',
    question: 'who knows quantum chemistry',
    expect: 'no-match',
    mustInclude: [],
    mayInclude: [],
    mustNotInclude: [],
    why: 'test fixture',
  }

  it('passes when every required member came back', () => {
    const verdict = judgeCase(matchesCase, { returned: ['aiko.tokyobuilders.eth'], noMatch: false })
    expect(verdict.passed).toBe(true)
    expect(verdict.missing).toHaveLength(0)
  })

  it('fails and names the member that was missing', () => {
    const verdict = judgeCase(matchesCase, { returned: ['kenji.tokyobuilders.eth'], noMatch: false })
    expect(verdict.passed).toBe(false)
    expect(verdict.missing).toEqual(['aiko.tokyobuilders.eth'])
  })

  it('fails when a forbidden name is returned', () => {
    const verdict = judgeCase(matchesCase, {
      returned: ['aiko.tokyobuilders.eth', 'mika.tokyobuilders.eth'],
      noMatch: false,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.forbiddenPresent).toEqual(['mika.tokyobuilders.eth'])
  })

  it('does not treat a mayInclude name as a failure', () => {
    const verdict = judgeCase(matchesCase, {
      returned: ['aiko.tokyobuilders.eth', 'kenji.tokyobuilders.eth'],
      noMatch: false,
    })
    expect(verdict.passed).toBe(true)
  })

  it('records an unexpected name without failing on it', () => {
    const verdict = judgeCase(matchesCase, {
      returned: ['aiko.tokyobuilders.eth', 'mei.tokyobuilders.eth'],
      noMatch: false,
    })
    expect(verdict.passed).toBe(true)
    expect(verdict.unexpected).toEqual(['mei.tokyobuilders.eth'])
  })

  it('passes an explicit no-match where one was expected', () => {
    const verdict = judgeCase(noMatchCase, { returned: [], noMatch: true })
    expect(verdict.passed).toBe(true)
    expect(verdict.note).toMatch(/explicit/i)
  })

  it('fails a no-match case when somebody was returned anyway', () => {
    const verdict = judgeCase(noMatchCase, { returned: ['aiko.tokyobuilders.eth'], noMatch: false })
    expect(verdict.passed).toBe(false)
  })

  it('compares names case-insensitively', () => {
    const verdict = judgeCase(matchesCase, { returned: ['Aiko.TokyoBuilders.ETH'], noMatch: false })
    expect(verdict.passed).toBe(true)
  })
})