// Validates every `src/**.ts:NN` reference in the markdown docs: the file must exist, be long
// enough, and the referenced line must plausibly be the thing the doc claims. Run after any edit
// that moves code, because a stale line reference is a claim a reviewer will check.
import { readFileSync, existsSync } from 'node:fs'
import { globSync } from 'node:fs'

const docs = ['README.md', 'action.md', ...globSync('docs/*.md').map(String)]
const problems = []
let checked = 0

for (const doc of docs) {
  if (!existsSync(doc)) continue
  const text = readFileSync(doc, 'utf8')
  for (const match of text.matchAll(/`((?:src|scripts)(?:\/[\w.-]+)+):(\d+)`/g)) {
    const [, file, lineText] = match
    const line = Number(lineText)
    checked += 1
    if (!existsSync(file)) {
      problems.push(`${doc}: ${file}:${line} - file does not exist`)
      continue
    }
    const lines = readFileSync(file, 'utf8').split('\n')
    if (line > lines.length) {
      problems.push(`${doc}: ${file}:${line} - file has only ${lines.length} lines`)
      continue
    }
    if (lines[line - 1].trim().length === 0) {
      problems.push(`${doc}: ${file}:${line} - blank line`)
    }
  }
  // `:NN` shorthand that follows a `path:NN` reference on the previous line.
  for (const match of text.matchAll(/`((?:src|scripts)\/[\w.-]+):(\d+)`[^\n]*\n[^\n]*`:(\d+)`/g)) {
    const [, file, , short] = match
    const lines = readFileSync(file, 'utf8').split('\n')
    checked += 1
    if (Number(short) > lines.length) {
      problems.push(`${doc}: ${file}:${short} (shorthand) - file has only ${lines.length} lines`)
    }
  }
}

console.log(`checked ${checked} reference(s) across ${docs.length} doc file(s)`)
if (problems.length === 0) {
  console.log('PASS: every file:line reference resolves to a real, non-blank line')
} else {
  console.log(`FAIL: ${problems.length} problem(s)`)
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}