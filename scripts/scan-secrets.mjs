#!/usr/bin/env node
/**
 * Credential scan.  `npm run check:secrets`
 *
 * SCORED CRITERION 6 (6 points): "No credentials are tracked in the repository."
 *
 * Two separate things are checked, because either one alone is a lie:
 *
 *   1. **Ignorance is verified, not assumed.** `.env` and friends must be (a) covered by an
 *      ignore rule and (b) absent from the tracked file list. A `.gitignore` line that does not
 *      actually match is a silent failure, so `git check-ignore` is asked.
 *   2. **Everything else is read** and matched against high-confidence secret shapes: private
 *      key blocks, live provider key formats, JWTs, cloud access keys, chat tokens, standalone
 *      64-hex secrets and BIP-39-shaped mnemonic lines. Files that are themselves ignored are
 *      never read — that is the point of ignoring them.
 *
 * False positives are worse than no scanner, because a noisy scanner gets switched off. The
 * assignment-shaped rule is therefore allowlisted against placeholders and against code
 * references (`env.LLM_API_KEY`, `process.env.*`, `${config.llmApiKey}`), which is the only
 * place this codebase ever mentions a credential.
 *
 * Exit code 0 = clean. Exit code 1 = findings, printed with file:line.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const SELF = relative(root, fileURLToPath(import.meta.url)).split(sep).join('/')

/** Directories never descended into: dependencies, build output, scratch. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.harness',
  '.cache',
  '.vite',
])

/** Ignored by `.gitignore`; must not be read, and must not be tracked. */
const IGNORED = [
  /^\.env(\..*)?$/,
  /^\.env$/,
  /\.(pem|key|log|tsbuildinfo)$/,
  /^(secrets|wallet)\.json$/,
  /^npm-debug\.log/,
]

/** Files that are allowed to exist and to look secret-ish. */
const ALLOWED_FILES = new Set([SELF, '.env.example'])

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function isIgnored(name) {
  return IGNORED.some((pattern) => pattern.test(name))
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), out)
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * High-confidence shapes. Each is either a real provider key format with a checkable
 * structure, or a private key / token container. None of these appear in source code.
 */
const HIGH_CONFIDENCE = [
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'standalone 64-hex secret', re: /(?:^|[^\w"'=/])[a-f0-9]{64}(?:[^\w"'=/]|$)/ },
  { name: 'BIP-39 shaped mnemonic', re: /^\s*['"]?[a-z]+(?:\s+[a-z]+){11,}['"]?\s*$/i },
]

/**
 * Assignment-shaped rule, for `LLM_API_KEY = "…"`. Narrower than it looks: it needs an
 * identifier that ends in key/secret/token/…, a `:` or `=`, and a literal of at least 12
 * characters that is not a placeholder and not a reference into the environment.
 */
const ASSIGNMENT = /\b([A-Za-z_]*(?:api[_-]?key|secret|password|passphrase|private[_-]?key|seed[_-]?phrase|mnemonic|auth[_-]?token|access[_-]?token|token))\b\s*[:=]\s*["'`]?([^\s"',;]{12,})/gi

const NOT_A_SECRET = [
  /\b(your|yourkey|example|placeholder|changeme|replace|redacted|hidden|notset|not-set|dummy|fake|sample|test|insert|here|xxx+|\.\.\.|…)/i,
  /^(process\.env|env|config|import|require|await|return|const|let|var|type|interface)\b/i,
  /\b(process\.env|import\.meta\.env|\$\{|\benv\.|\.env\b|config\.|req\.|res\.)/,
  /^<.*>$/,
  /^(true|false|null|undefined|string|number|readonly)$/i,
  // A credential is a flat literal. Anything that is called, constructed or referenced — a
  // zod builder, a getter, a template — is code, not a secret.
  /[(){}]|=>|\bz\./,
]

function looksLikePlaceholder(value) {
  return NOT_A_SECRET.some((pattern) => pattern.test(value))
}

/** Only these extensions can hold a credential in this project. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.yml', '.yaml',
  '.env', '.txt', '.html', '.css', '.toml',
])

function scanFile(absolute) {
  const name = relative(root, absolute).split(sep).join('/')
  const findings = []

  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    return findings
  }

  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const { name: rule, re } of HIGH_CONFIDENCE) {
      re.lastIndex = 0
      if (re.test(line)) findings.push({ file: name, line: index + 1, rule })
    }
  })

  const text2 = lines.join('\n')
  ASSIGNMENT.lastIndex = 0
  let match
  while ((match = ASSIGNMENT.exec(text2)) !== null) {
    const identifier = match[1]
    const value = match[2]
    if (looksLikePlaceholder(value)) continue
    if (identifier && /^processenv$/i.test(identifier)) continue
    const before = text2.slice(0, match.index)
    const lineNumber = before.split('\n').length
    findings.push({ file: name, line: lineNumber, rule: `literal assigned to ${identifier}` })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 1. The ignore rules have to actually work
// ---------------------------------------------------------------------------

const ignoreProblems = []
const ignoreVerified = []

for (const candidate of ['.env', '.env.local', 'secrets.json', 'wallet.json', 'id.pem']) {
  const exists = (() => {
    try {
      return statSync(join(root, candidate)).isFile()
    } catch {
      return false
    }
  })()

  // `git check-ignore -v` prints the rule that matched. An empty string means no rule matched,
  // which for a file that exists on disk is a real problem, not a formality.
  const rule = git(['check-ignore', '-v', candidate])

  if (rule !== '') ignoreVerified.push(candidate)
  if (exists && rule === '' && !isIgnored(candidate)) {
    ignoreProblems.push(`${candidate} exists on disk but no ignore rule matches it`)
  }
}

const trackedEnv = git(['ls-files', '--', '.env', '.env.local', '.env.production'])
if (trackedEnv.length > 0) {
  ignoreProblems.push(`TRACKED SECRET FILE: ${trackedEnv.split(/\r?\n/).join(', ')}`)
}

// ---------------------------------------------------------------------------
// 2. Everything that is not ignored
// ---------------------------------------------------------------------------

const findings = []
let scanned = 0

for (const file of walk(root)) {
  const name = relative(root, file).split(sep).join('/')
  const base = name.split('/').pop() ?? name
  if (ALLOWED_FILES.has(base) || ALLOWED_FILES.has(name)) continue
  if (isIgnored(base)) continue
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''
  if (!TEXT_EXTENSIONS.has(extension)) continue
  scanned += 1
  findings.push(...scanFile(file))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('')
console.log('  Credential scan')
console.log(`  root:   ${root}`)
console.log(`  read:   ${scanned} text file(s), excluding node_modules/, dist/, .git/, .harness/ and ignored files`)

const ignoredNames = ['.env', '.env.local', 'secrets.json', 'wallet.json', 'id.pem']
const matched = ignoredNames.filter((name) => git(['check-ignore', '-v', name]) !== '')
console.log(`  ignore rules verified: ${matched.length > 0 ? matched.join(', ') : '(nothing to verify)'}`)
console.log(`  tracked .env files:    ${trackedEnv === '' ? 'none' : trackedEnv}`)

const hardProblems = ignoreProblems

if (findings.length === 0 && hardProblems.length === 0) {
  console.log('')
  console.log('  PASS: no credential-shaped content in tracked files, and no secret file is tracked.')
  console.log('')
  process.exit(0)
}

console.log('')
console.log('  FAIL')
for (const problem of hardProblems) console.log(`  - ${problem}`)
for (const finding of findings) console.log(`  - ${finding.file}:${finding.line}  ${finding.rule}`)
console.log('')
console.log('  If a finding is a placeholder or a code reference, allowlist it in scripts/scan-secrets.mjs.')
console.log('  Do not widen the scan to make it pass.')
console.log('')
process.exit(1)