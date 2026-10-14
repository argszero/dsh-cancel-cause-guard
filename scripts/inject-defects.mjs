/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT —
 * it proves nothing about the test that was supposed to hold the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`) in
 * the tree would be worse than no injector, and a stale `lib/` is exactly how an
 * arm goes SILENT.
 *
 * Every mutation here is a defect this plugin could plausibly ship — a union
 * check loosened, a rewrite skipped, a bound ignored, a restore that restores
 * nothing, a lifecycle edge that stops tracking the agents it guarded. None is
 * engineered to be caught: each names the shape of mistake the arm exists for.
 *
 * The whole suite runs for every arm (it takes a fraction of a second), so an arm
 * may be caught by more than one test; what is asserted is that SOMETHING goes
 * red, which is the only thing a mutation can prove on its own.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 *
 * The anchors are source *prose*, so an edit to a mutated line re-anchors its arm
 * in the same change — a missing anchor is reported as SKIP and fails the run
 * rather than quietly proving less.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SUITE = '*.spec.mjs'

const MUTATIONS = [
  // ---------------------------------------------------------------- cause.ts
  {
    name: 'an out-of-union value is forwarded unchanged, so the rewrite the plugin exists for never happens',
    file: 'src/cause.ts',
    edits: [['  if (isCancelCause(cause)) return cause', '  if (isCancelCause(cause) && cause === undefined) return cause']],
  },
  {
    name: 'a hook whose reason is not text passes as a member, so a plugin moves the failure instead of preventing it',
    file: 'src/cause.ts',
    edits: [["      return typeof readField(cause, 'reason') === 'string'", '      return true']],
  },
  {
    name: 'the default reason bound is ignored, so a hostile value can write an unbounded reason into the log',
    file: 'src/cause.ts',
    edits: [['  const limit = options.maxReasonChars ?? DEFAULT_MAX_REASON_CHARS', '  const limit = options.maxReasonChars ?? 1_000_000']],
  },
  {
    name: 'an empty reason override is honoured, so a configured guard names nothing at all',
    file: 'src/cause.ts',
    edits: [['  if (options.reason !== undefined && options.reason.length > 0) {', '  if (options.reason !== undefined && options.reason.length >= 0) {']],
  },
  {
    name: 'a blank string cause is recorded as the reason, so a nameless value reads as a non-empty one',
    file: 'src/cause.ts',
    edits: [['    return value.trim().length === 0 ? UNSPECIFIED_REASON : truncate(value, maxChars)', '    return truncate(value, maxChars)']],
  },
  {
    name: 'null is treated as a value with a name, so the absence reads as the string "null"',
    file: 'src/cause.ts',
    edits: [['  if (value === undefined || value === null) return UNSPECIFIED_REASON', '  if (value === undefined) return UNSPECIFIED_REASON']],
  },
  {
    name: 'a described string is not quoted, so an empty one is indistinguishable from an absent one in the log',
    file: 'src/cause.ts',
    edits: [['  if (typeof value === \'string\') return truncate(JSON.stringify(value), maxChars)', '  if (typeof value === \'string\') return truncate(value, maxChars)']],
  },
  {
    name: 'the name a value carried is ignored, so `{ kind: "thinking-loop" }` is recorded as JSON instead of the token',
    file: 'src/cause.ts',
    edits: [['  const named = carriedKind(value)', '  const named = undefined']],
  },
  {
    name: 'the bound is off by one, so a reason exactly at the configured length is truncated anyway',
    file: 'src/cause.ts',
    edits: [['  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`', '  return text.length < maxChars ? text : `${text.slice(0, maxChars - 1)}…`']],
  },
  {
    name: 'a blank kind counts as a name, so a value whose kind is whitespace is reported as that whitespace',
    file: 'src/cause.ts',
    edits: [["  return typeof kind === 'string' && kind.trim().length > 0 ? kind : undefined", "  return typeof kind === 'string' ? kind : undefined"]],
  },
  {
    name: 'a value JSON cannot render is reported as nameable, so a BigInt cause loses its own name',
    file: 'src/cause.ts',
    edits: [['    return String(value)', '    return UNSPECIFIED_REASON']],
  },
  // --------------------------------------------------------------- config.ts
  {
    name: 'a configuration that is not an object is accepted, so a mounted string resolves to defaults silently',
    file: 'src/config.ts',
    edits: [['  if (config === null || typeof config !== \'object\' || Array.isArray(config)) {', '  if (config === null) {']],
  },
  {
    name: 'an unknown key is accepted, so a misspelled knob mounts and guards nothing',
    file: 'src/config.ts',
    edits: [['    if (!CONFIG_KEYS.has(key)) {', "    if (key === '__never_known__') {"]],
  },
  {
    name: 'the mode test is inverted, so the two modes this plugin has are refused and every other string is taken',
    file: 'src/config.ts',
    edits: [['  if (typeof mode !== \'string\' || !MODES.has(mode)) {', "  if (typeof mode !== 'string' || MODES.has(mode)) {"]],
  },
  {
    name: 'the positive-integer check is loosened, so NaN and a fractional bound reach the truncation',
    file: 'src/config.ts',
    edits: [['  if (!Number.isSafeInteger(maxReasonChars) || maxReasonChars < 1) {', '  if (maxReasonChars < 1) {']],
  },
  {
    name: 'a reason that names nothing is accepted, so the one outcome a reason field exists to prevent mounts',
    file: 'src/config.ts',
    edits: [["  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0)) {", "  if (reason !== undefined && typeof reason !== 'string') {"]],
  },
  {
    name: 'the default mode is observe, so a mount with no configuration reports instead of repairing',
    file: 'src/config.ts',
    edits: [['  const mode = config.mode ?? DEFAULTS.mode', "  const mode = config.mode ?? 'observe'"]],
  },
  // ---------------------------------------------------------------- guard.ts
  {
    name: 'an instance whose cancel is not a function is patched anyway, so a broken agent is reported as guarded',
    file: 'src/guard.ts',
    edits: [["  if (typeof current !== 'function') return { outcome: 'no-cancel', restore: () => {} }", "  if (typeof current === 'object') return { outcome: 'no-cancel', restore: () => {} }"]],
  },
  {
    name: 'the already-guarded test looks for the wrong value, so an unmarked method is skipped and a marked one is wrapped again',
    file: 'src/guard.ts',
    edits: [['  if ((current as MarkedFunction)[GUARD_MARK] === true) {', '  if ((current as MarkedFunction)[GUARD_MARK] === undefined) {']],
  },
  {
    name: 'the write-back is read as a prototype method, so undoing the shadow writes the method in as an own property',
    file: 'src/guard.ts',
    edits: [["  const hadOwn = Object.prototype.hasOwnProperty.call(agent, 'cancel')", '  const hadOwn = true']],
  },
  {
    name: 'the original is invoked with no receiver, so a guarded cancellation throws inside the guard',
    file: 'src/guard.ts',
    edits: [['    Reflect.apply(original, agent, [decided, cancelOptions])', '    Reflect.apply(original, undefined, [decided, cancelOptions])']],
  },
  {
    name: 'the rewrite is computed and discarded, so the caller\'s out-of-union value reaches the method unchanged',
    file: 'src/guard.ts',
    edits: [['    const decided = decide(cause, options)', '    const decided = cause']],
  },
  {
    name: 'an already-valid cause is reported as rewritten, so a working cancellation is logged as a defect',
    file: 'src/guard.ts',
    edits: [['  if (isCancelCause(cause)) return cause', '  if (isCancelCause(cause) === false) return cause']],
  },
  {
    name: 'observe mode rewrites as well, so the operator who asked for a report gets a repair instead',
    file: 'src/guard.ts',
    edits: [["  return options.mode === 'observe' ? cause : normalized", '  return cause']],
  },
  {
    name: 'the install is confirmed by the wrong comparison, so every successful write is reported as refused',
    file: 'src/guard.ts',
    edits: [['  if ((agent as { cancel?: unknown }).cancel !== wrapper) {', '  if ((agent as { cancel?: unknown }).cancel === wrapper) {']],
  },
  {
    name: 'the undo unwinds a shadow that is no longer ours, so a later guard\'s wrapper is deleted by this one',
    file: 'src/guard.ts',
    edits: [['      if ((agent as { cancel?: unknown }).cancel !== wrapper) return', '      if ((agent as { cancel?: unknown }).cancel === wrapper) return']],
  },
  {
    name: 'the own-property case is unwound the other way round, so a restored instance is not the object that was found',
    file: 'src/guard.ts',
    edits: [[
      "      if (hadOwn) (agent as { cancel: unknown }).cancel = original\n      else delete (agent as { cancel?: unknown }).cancel",
      "      if (!hadOwn) (agent as { cancel: unknown }).cancel = original\n      else delete (agent as { cancel?: unknown }).cancel",
    ]],
  },
  {
    name: 'the installed wrapper is left unmarked, so a second copy of this plugin normalizes a cause twice',
    file: 'src/guard.ts',
    edits: [['  wrapper[GUARD_MARK] = true', '  void GUARD_MARK']],
  },
  // ---------------------------------------------------------------- index.ts
  {
    name: 'the plugin is named something else, so a profile entry and its diagnostics do not agree',
    file: 'src/index.ts',
    edits: [["export const name = 'cancel-cause-guard'", "export const name = 'cancel-guard'"]],
  },
  {
    name: 'the plugin declares a service it does not use, so a profile that lacks it cannot mount it',
    file: 'src/index.ts',
    edits: [['export const inject: readonly string[] = []', "export const inject: readonly string[] = ['llm']"]],
  },
  {
    name: 'the fiber\'s unwind forgets to restore, so unmounting leaves a shadow on every live agent',
    file: 'src/index.ts',
    edits: [['    for (const shadows of guards.values()) restoreShadows(shadows)', '    for (const shadows of guards.values()) void shadows.cancel']],
  },
  {
    name: 'a guarded agent is not tracked, so its disposal leaves the shadow in place forever',
    file: 'src/index.ts',
    edits: [['      case \'patched\':\n        shadows.cancel = handle', "      case 'patched':\n        void handle"]],
  },
  {
    name: 'the agent\'s disposal does not restore, so the guard outlives the agent it shadowed',
    file: 'src/index.ts',
    edits: [['    restoreShadows(shadows)\n    guards.delete(agent)', '    void shadows\n    guards.delete(agent)']],
  },
  {
    name: 'the two modes are reported the other way round, so the log claims a repair that did not happen',
    file: 'src/index.ts',
    edits: [["  const outcome = mode === 'observe'", "  const outcome = mode === 'normalize'"]],
  },
  {
    name: 'the durable backstop is installed only when it is switched off, so a default mount leaves the null row reachable',
    file: 'src/index.ts',
    edits: [['    if (settings.backstop) {', '    if (!settings.backstop) {']],
  },
  {
    name: 'a backstopped session is not tracked, so its disposal leaves the append shadow in place forever',
    file: 'src/index.ts',
    edits: [['        case \'patched\':\n          shadows.append = backstop', "        case 'patched':\n          void backstop"]],
  },
  {
    name: 'the unwind forgets the append shadow, so unmounting leaves every session wrapped',
    file: 'src/index.ts',
    edits: [['  shadows.cancel?.restore()\n  shadows.append?.restore()', '  shadows.cancel?.restore()']],
  },
  // ------------------------------------------------------------ backstop.ts
  {
    name: 'the event filter is inverted, so every event but turn/end is inspected and rewritten',
    file: 'src/backstop.ts',
    edits: [['  if (args[0] !== TURN_END) return undefined', '  if (args[0] === TURN_END) return undefined']],
  },
  {
    name: 'a reason a reader can dereference is rewritten anyway, so a working turn ending is replaced',
    file: 'src/backstop.ts',
    edits: [['  if (isReadableTurnEndReason(reason)) return undefined', '  if (isReadableTurnEndReason(reason) && args.length > 99) return undefined']],
  },
  {
    name: 'the kind test is loosened, so an empty kind passes as a reason a reader can read',
    file: 'src/backstop.ts',
    edits: [['  return typeof kind === \'string\' && kind.trim().length > 0', '  return kind !== undefined']],
  },
  {
    name: 'the replacement row names the caller rather than the plugin, so the log blames a member that cannot be it',
    file: 'src/backstop.ts',
    edits: [['    reason: { kind: \'aborted\', reason: { kind: \'hook\', reason: unseenCauseReason(options) } },', "    reason: { kind: 'aborted', reason: { kind: 'parent' } },"]],
  },
  {
    name: 'observe mode repairs as well, so the operator who asked for a report gets the row rewritten instead',
    file: 'src/backstop.ts',
    edits: [["    if (options.mode === 'observe') return Reflect.apply(original, session, args)", "    if (options.mode === 'normalize') return Reflect.apply(original, session, args)"]],
  },
  {
    name: 'the install is confirmed by the wrong comparison, so every successful write is reported as refused',
    file: 'src/backstop.ts',
    edits: [['  if ((session as { append?: unknown }).append !== wrapper) {', '  if ((session as { append?: unknown }).append === wrapper) {']],
  },
  {
    name: 'the undo unwinds a shadow that is no longer ours, so a later guard\'s wrapper is deleted by this one',
    file: 'src/backstop.ts',
    edits: [['      if ((session as { append?: unknown }).append !== wrapper) return', '      if ((session as { append?: unknown }).append === wrapper) return']],
  },
  {
    name: 'the installed wrapper is left unmarked, so a second copy of this plugin backstops a session twice',
    file: 'src/backstop.ts',
    edits: [['  wrapper[APPEND_GUARD_MARK] = true', '  void APPEND_GUARD_MARK']],
  },
  {
    name: 'the payload is rebuilt from the reason alone, so the rest of the row the loop wrote is dropped',
    file: 'src/backstop.ts',
    edits: [['    forwarded[1] = { ...(args[1] as Record<string, unknown>), reason: decided.reason }', '    forwarded[1] = { reason: decided.reason }']],
  },
  {
    name: 'the configured reason is ignored, so an operator who named the defect reads the default text instead',
    file: 'src/backstop.ts',
    edits: [['  const text = options.reason ?? UNSEEN_CAUSE_REASON', '  const text = UNSEEN_CAUSE_REASON']],
  },
  {
    name: 'the reason minted for a repaired row is unbounded, so a configured bound does not hold on this path',
    file: 'src/backstop.ts',
    edits: [['  return truncate(text, options.maxReasonChars)', '  return text']],
  },
  {
    name: 'a reason that was absent is described as one that was null, so the log misnames what arrived',
    file: 'src/backstop.ts',
    edits: [["  if (reason === undefined) return 'absent'", "  if (reason === undefined) return 'null'"]],
  },
  // ------------------------------------------------------------- config.ts
  {
    name: 'the durable backstop defaults to off, so a default mount leaves the append path unguarded',
    file: 'src/config.ts',
    edits: [['  backstop: true,', '  backstop: false,']],
  },
  {
    name: 'the backstop switch is refused the wrong way round, so booleans are refused and typo strings are taken',
    file: 'src/config.ts',
    edits: [["  if (typeof backstop !== 'boolean') {", "  if (typeof backstop === 'boolean') {"]],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run the suite; true when it failed, plus its output. */
function runSuite() {
  try {
    execFileSync(process.execPath, ['--test', `test/${SUITE}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes every
// CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite()
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
let missing = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) {
    missing += 1
    continue
  }

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite()
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a mutation
    // or a stale `lib/` behind is the failure mode this file exists to avoid.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught) silent += 1
  console.log(`${caught ? 'CAUGHT' : 'SILENT'}: ${mutation.name}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}; ANCHOR MISSING: ${String(missing)}`)
if (silent > 0 || unbuildable > 0 || missing > 0) process.exit(1)
