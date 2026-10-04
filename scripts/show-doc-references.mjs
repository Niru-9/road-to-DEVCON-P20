// Prints what each `file:line` reference in the docs actually points at, so a reviewer (or I)
// can confirm the claim matches the code. Read-only helper for `check-doc-references.mjs`.
import { readFileSync, readdirSync } from 'node:fs'

const docs = ['README.md', 'action.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]
const seen = new Set()

for (const doc of docs) {
  const text = readFileSync(doc, 'utf8')
  for (const match of text.matchAll(/`((?:src|scripts)(?:\/[\w.-]+)+):(\d+)`/g)) {
    const key = `${match[1]}:${match[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    const line = readFileSync(match[1], 'utf8').split('\n')[Number(match[2]) - 1].trim()
    console.log(`${key.padEnd(36)} ${line.slice(0, 92)}`)
  }
}