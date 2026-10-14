/**
 * The consequence, proved against the harness's own code rather than against a
 * stand-in.
 *
 * The suite's fixtures record the cause that reached `cancel`; they cannot show
 * what the harness then does with an out-of-union value, because that happens in
 * `@deepseek-ai/dsh-agent-loop`'s turn body. So this script takes the **published**
 * `abortedCancelCause` — extracted from the npm tarball of each released harness
 * line, not re-typed here — and runs it against four causes:
 *
 * - the bare string three discussions report (`agent.cancel('thinking-loop')`);
 * - an object whose `kind` the union does not have;
 * - `undefined`, from a caller whose own declaration made the argument optional;
 * - and the value this plugin's shipped `normalizeCancelCause` produces for each.
 *
 * A value that leaves `abortedCancelCause` throwing is the defect end to end: the
 * function is called **inside the turn's `catch`**, so the throw happens before
 * `turnEnds` is assigned, and the unconditional `finally` then appends
 * `turn/end` with that `null` (`agent-loop/src/agent.ts:385`). The last arm is
 * what the plugin buys: the same cause, and a union member comes back.
 *
 * `0.1.6-alpha.2` is included as the version boundary rather than as a
 * supported line: it has no such function at all, which is why the same abuse
 * was survivable before `0.1.7` and fatal from `0.1.7-rc.2` on.
 *
 * Run from the plugin root, with npm on `PATH`: `npm run witness:cancel-cause`.
 * Exits non-zero if any line behaves differently from the reading above.
 *
 * @module scripts/witness-cancel-cause
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCancelCause } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, 'tmp', 'witness')

/** The published lines to witness, oldest first, with the boundary line marked. */
const LINES = [
  { version: '0.1.6-alpha.2', boundary: true },
  { version: '0.1.7-rc.2' },
  { version: '0.2.0-rc.2' },
  { version: '0.2.1-alpha.2' },
]

/** The causes every line is run against. */
const CAUSES = [
  ['a bare string, as three discussions report', 'thinking-loop'],
  ['an object whose kind the union does not have', { kind: 'thinking-loop' }],
  ['an object that carries no kind at all', {}],
  ['undefined, which `abort()` substitutes a fresh AbortError for', undefined],
]

/**
 * `npm`, as a command this process can actually run.
 *
 * `scripts/` is executed by the same node that built the package, and npm lives
 * beside it in every normal install — including the asdf one this was developed
 * against, where `npm` is not on the PATH a subshell inherits.
 * @returns the npm executable path, or bare `npm` when no sibling exists.
 */
function npm() {
  const sibling = join(dirname(process.execPath), 'npm')
  try {
    execFileSync(sibling, ['--version'], { stdio: 'ignore' })
    return sibling
  } catch {
    return 'npm'
  }
}

/**
 * Extract one top-level function declaration from a bundle, by matching braces.
 *
 * The published files are compiled bundles, so the declaration is the source of
 * truth — and reading it out is what makes this script a witness rather than a
 * second implementation of the same idea.
 * @param source - the bundle's text.
 * @param name - the function to extract.
 * @returns the declaration's text.
 * @throws when the bundle does not declare it.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`no function ${name} in this bundle`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces after function ${name}`)
}

/**
 * Download and unpack one package at one version.
 * @param spec - `name@version`.
 * @returns the package directory the tarball unpacked to.
 */
function fetchPackage(spec) {
  const dir = join(SCRATCH, spec.replace(/[@/]/gu, '_'))
  mkdirSync(dir, { recursive: true })
  const tarball = execFileSync(npm(), ['pack', spec, '--silent'], { cwd: dir, encoding: 'utf8' }).trim()
  execFileSync('tar', ['-xzf', tarball, '-C', dir], { cwd: dir, stdio: 'pipe' })
  return join(dir, 'package')
}

/**
 * Build the real `abortedCancelCause` of one line, with that line's own
 * `assertNever` bound in.
 * @param version - the harness version to read.
 * @returns the extracted function, or `null` when the line predates it.
 */
function loadAbortedCancelCause(version) {
  const loop = readFileSync(join(fetchPackage(`@deepseek-ai/dsh-agent-loop@${version}`), 'lib/index.js'), 'utf8')
  if (!loop.includes('function abortedCancelCause(')) return null
  const values = readFileSync(join(fetchPackage(`@deepseek-ai/dsh-util-values@${version}`), 'lib/index.js'), 'utf8')
  // `assertNever` is taken from the same line's own bundle rather than from this
  // plugin's dependencies: the message a reader sees is part of what is being
  // witnessed, and a newer copy would put a newer sentence in it.
  const build = new Function(
    'assertNever',
    `${extractFunction(values, 'assertNever')}\n${extractFunction(loop, 'abortedCancelCause')}\nreturn abortedCancelCause`,
  )
  return build()
}

/**
 * Name the value `abortedCancelCause` actually reads.
 *
 * Not always what the caller passed: `AbortController.abort()` replaces an
 * `undefined` reason with a fresh `AbortError`, so the loop's first dereference
 * is of a DOMException rather than of nothing at all. Printing the reason is what
 * keeps this report descriptive rather than merely persuasive.
 * @param reason - `signal.reason` after the abort.
 * @returns a short description.
 */
function describeReason(reason) {
  if (reason === undefined) return 'undefined'
  if (typeof reason === 'object' && reason !== null && typeof reason.kind === 'string') {
    return `kind ${JSON.stringify(reason.kind)}`
  }
  return Object.prototype.toString.call(reason)
}

/**
 * Run one cause through one line's `abortedCancelCause`.
 * @param abortedCancelCause - the extracted function.
 * @param cause - the value a caller passed to `cancel`.
 * @returns how the harness answered, and what it was reading.
 */
function run(abortedCancelCause, cause) {
  const controller = new AbortController()
  controller.abort(cause)
  const reading = describeReason(controller.signal.reason)
  try {
    return { kind: 'returned', value: abortedCancelCause(controller.signal), reading }
  } catch (error) {
    return { kind: 'threw', value: error.message, reading }
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

let failures = 0
for (const { version, boundary } of LINES) {
  process.stdout.write(`\n===== @deepseek-ai/dsh-agent-loop@${version} =====\n`)
  const abortedCancelCause = loadAbortedCancelCause(version)

  if (abortedCancelCause === null) {
    // The version boundary is a reading, not a failure: before this function
    // existed the turn's catch recorded the raw value, so the abuse produced a
    // malformed row rather than a null one.
    console.log(`${boundary ? 'BOUNDARY' : 'ABSENT'}: no abortedCancelCause in this line; `
      + 'a mis-typed cause was recorded verbatim instead of becoming null')
    if (!boundary) failures += 1
    continue
  }

  for (const [label, cause] of CAUSES) {
    const raw = run(abortedCancelCause, cause)
    const guarded = run(abortedCancelCause, normalizeCancelCause(cause))
    console.log(`cause: ${label}`)
    console.log(`  as passed : reason is ${raw.reading} -> ${raw.kind} ${JSON.stringify(raw.value)}`)
    console.log(`  as guarded: reason is ${guarded.reading} -> ${guarded.kind} ${JSON.stringify(guarded.value)}`)

    if (raw.kind !== 'threw') {
      console.log('  UNEXPECTED: the unguarded cause did not throw, so this line is not the one the reports describe')
      failures += 1
    }
    if (guarded.kind !== 'returned' || guarded.value?.kind !== 'hook' || typeof guarded.value.reason !== 'string') {
      console.log('  FAIL: the guarded cause did not come back as a hook member')
      failures += 1
    }
  }

  // The cause a plugin is supposed to pass is unchanged by all of this — the
  // guard must not be visible on a cancellation that was always correct.
  const valid = run(abortedCancelCause, { kind: 'user' })
  console.log('cause: a valid member, unguarded')
  console.log(`  as passed : reason is ${valid.reading} -> ${valid.kind} ${JSON.stringify(valid.value)}`)
  if (valid.kind !== 'returned' || valid.value.kind !== 'user') {
    console.log('  FAIL: a valid member did not survive the loop\'s own reading')
    failures += 1
  }
}

// A note in the tree for whoever reads the run later, and the exit code for CI.
writeFileSync(join(SCRATCH, 'README.txt'), 'Scratch trees from scripts/witness-cancel-cause.mjs; safe to delete.\n')
console.log(`\nWITNESS FAILURES: ${failures === 0 ? 'none' : String(failures)}`)
process.exit(failures === 0 ? 0 : 1)
