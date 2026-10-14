/**
 * The durable backstop: the `turn/end` row is never committed with a reason the
 * conversation view cannot read.
 *
 * ## Why the cause guard alone is not enough
 *
 * The entry guard (`./guard.ts`) normalizes a cause before the loop ever sees it,
 * and it covers every caller that goes through the **instance** method — which is
 * every caller in the shipped tree. Two callers it cannot cover remain, and both
 * end with the same unreadable row:
 *
 * - a caller that reaches the class rather than the instance
 *   (`ReactLoopAgent.prototype.cancel.call(agent, cause)`, or a second copy of the
 *   loop in the same process), which no observable hook hands over; and
 * - an agent instance that refuses the own `cancel` property, where the entry
 *   guard reports `not-writable` and is simply absent.
 *
 * In both cases the out-of-union cause reaches `abortedCancelCause`'s
 * `assertNever` **inside the turn's `catch`**, `turnEnds` stays at its `null`
 * initializer, and the unconditional `finally` commits
 * `{"type":"turn/end","data":{"turn":N,"reason":null}}`. The write path accepts it
 * — `validateSessionEventData` inspects surface message slots, `request/header`
 * and `tool/result`, and `turn/end.reason` is a TypeScript-only invariant — so
 * the row is durable before any reader can object. The chat client then
 * dereferences `reason.kind` while rendering and throws, which blanks the whole
 * conversation area, for every session, across restarts.
 *
 * ## The seam
 *
 * `Session.append` is a **prototype** method of the session the agent holds, so an
 * own-property write on `agent.session` shadows it for every writer — the loop's
 * own `turn/start` / `step/start` / `turn/end` and any plugin's, alike. Only one
 * event type is inspected; everything else is forwarded untouched.
 *
 * ## What it writes
 *
 * It does not invent a variant. A new `kind` would be a value the readers switch
 * over have never seen, which trades a loud failure for a silent one — and
 * `TurnEndReasonMap` is merge-extensible, so this plugin cannot even enumerate
 * the members. It writes instead **the row the loop meant to write**: the turn was
 * interrupted by a cancellation, and the cause came from outside the closed union,
 * so it is `{ kind: 'aborted', reason: { kind: 'hook', reason: <text> } }` —
 * `aborted` is a member every reader knows, and `hook` is the member
 * `AgentCancelCause` reserves for whoever outside the union cancelled the turn.
 *
 * The test is deliberately **dereferenceability, not membership**: a reason is
 * left alone when it is a non-null object carrying a non-empty string `kind`,
 * because a plugin may legitimately extend `TurnEndReasonMap` with a variant this
 * plugin knows nothing about. What is refused is the shape no reader can read at
 * all — `null`, absent, or not an object.
 *
 * @module @argszero/dsh-cancel-cause-guard/backstop
 */

import { truncate } from './cause.ts'
import type { BackstopHandle, BackstopOptions, BackstopOutcome, RepairedTurnEnd } from './types.ts'

/**
 * The brand an installed append wrapper carries.
 *
 * `Symbol.for` for the reason {@link GUARD_MARK} uses it: two copies of this
 * plugin in one process must recognise each other's work rather than stack.
 */
export const APPEND_GUARD_MARK: unique symbol = Symbol.for('argszero.dsh-cancel-cause-guard/append-guarded')

/** The event type this backstop inspects, and the only one it rewrites. */
const TURN_END = 'turn/end'

/**
 * The reason text for a row whose reason carried nothing at all.
 *
 * Named for what the operator has to know: the cancellation did not pass the
 * entry guard, so its cause was never seen and cannot be named.
 */
export const UNSEEN_CAUSE_REASON = 'a cancellation cause the entry guard never saw'

/** The shape a marked wrapper has, for the recognition check. */
type MarkedFunction = ((...args: never[]) => unknown) & { [APPEND_GUARD_MARK]?: true }

/**
 * Whether a value is a reason a reader can dereference.
 *
 * The whole consequence of the defect is one expression — `reason.kind` — so the
 * property this asks about is exactly that one: an object, not null, whose `kind`
 * is non-empty text. Membership in `TurnEndReasonMap` is deliberately **not**
 * asked, because the map is merge-extensible and a plugin's own variant would
 * then be rewritten by a plugin that had never heard of it.
 * @param reason - the value the loop is about to commit as `turn/end.reason`.
 * @returns whether a reader may dereference `reason.kind`.
 */
export function isReadableTurnEndReason(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const kind: unknown = readKind(reason)
  return typeof kind === 'string' && kind.trim().length > 0
}

/**
 * The reason to commit for a row whose own reason is unreadable.
 *
 * The configured reason wins when the operator set one; otherwise the text says
 * the one thing that is certainly true — no entry guard saw this cancellation.
 * @param options - the configured reason and its bound.
 * @returns the reason text for the replacement row.
 */
export function unseenCauseReason(options: { reason?: string | undefined; maxReasonChars: number }): string {
  const text = options.reason ?? UNSEEN_CAUSE_REASON
  return truncate(text, options.maxReasonChars)
}

/**
 * Shadow one session's `append` so an unreadable `turn/end` reason never lands.
 *
 * Every refusal is reported as an outcome rather than thrown: a session this
 * plugin could not guard is a session that keeps the defect, not a reason to fail
 * the lifecycle edge that delivered it.
 * @param session - the live session the agent appends to.
 * @param options - the mode, the reason override, the bound, and the report callback.
 * @returns the outcome and an undo.
 */
export function guardSessionAppend(session: unknown, options: BackstopOptions): BackstopHandle {
  if (session === undefined || session === null) return { outcome: 'no-append', restore: () => {} }
  const current: unknown = (session as { append?: unknown }).append
  if (typeof current !== 'function') return { outcome: 'no-append', restore: () => {} }
  if ((current as MarkedFunction)[APPEND_GUARD_MARK] === true) {
    return { outcome: 'already-guarded', restore: () => {} }
  }

  const original = current as (...args: unknown[]) => unknown
  // Whether the property was the instance's own before the guard: a prototype
  // method must be revealed again by deleting the shadow, an own property by
  // writing the old value back.
  const hadOwn = Object.prototype.hasOwnProperty.call(session, 'append')

  const wrapper = function guardedAppend(...args: unknown[]): unknown {
    const decided = decide(args, options)
    if (decided === undefined) return Reflect.apply(original, session, args)
    options.onRepaired(decided.report)
    // In `observe` mode the report is the whole contribution: the unreadable row
    // is committed exactly as it would have been, so the operator sees the real
    // failure, and the log names it rather than claiming a repair.
    if (options.mode === 'observe') return Reflect.apply(original, session, args)
    const forwarded = args.slice()
    forwarded[1] = { ...(args[1] as Record<string, unknown>), reason: decided.reason }
    return Reflect.apply(original, session, forwarded)
  } as MarkedFunction
  wrapper[APPEND_GUARD_MARK] = true

  try {
    ;(session as { append: unknown }).append = wrapper
  } catch {
    // A sealed session, or an `append` defined without a setter.
    return { outcome: 'not-writable', restore: () => {} }
  }
  // A refusal to write is not always a throw — a frozen object in sloppy mode
  // would simply ignore it — so the install is confirmed by reading it back.
  if ((session as { append?: unknown }).append !== wrapper) {
    return { outcome: 'not-writable', restore: () => {} }
  }

  let installed = true
  return {
    outcome: 'patched',
    restore: (): void => {
      if (!installed) return
      installed = false
      // Only unwind a shadow that is still ours: a later guard, or the session
      // itself, may have replaced it, and undoing that would be a third party's
      // state being written by this one.
      if ((session as { append?: unknown }).append !== wrapper) return
      if (hadOwn) (session as { append: unknown }).append = original
      else delete (session as { append?: unknown }).append
    },
  }
}

/**
 * What one `append` call should become, if anything.
 *
 * Only `turn/end` with an object payload is eligible. A payload that is not an
 * object is left alone rather than rebuilt: the event map promises `{ turn, reason }`,
 * and a setter that invented the missing half would be writing a row of its own
 * making into a durable log. It is reported instead.
 * @param args - the arguments the caller passed to `append`.
 * @param options - the configured reason and its bound.
 * @returns the reason to commit and the report, or undefined when nothing changes.
 */
function decide(args: readonly unknown[], options: BackstopOptions): { reason: unknown; report: RepairedTurnEnd } | undefined {
  if (args[0] !== TURN_END) return undefined
  const data: unknown = args[1]
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const reason = (data as Record<string, unknown>).reason
  if (isReadableTurnEndReason(reason)) return undefined
  return {
    reason: { kind: 'aborted', reason: { kind: 'hook', reason: unseenCauseReason(options) } },
    report: {
      turn: (data as Record<string, unknown>).turn,
      original: reason,
      normalized: { kind: 'hook', reason: unseenCauseReason(options) },
      described: describeReason(reason),
    },
  }
}

/** A rendering of the unreadable reason, for the log line. */
function describeReason(reason: unknown): string {
  if (reason === undefined) return 'absent'
  if (reason === null) return 'null'
  const kind: unknown = typeof reason === 'object' ? readKind(reason) : undefined
  if (typeof kind === 'string' && kind.trim().length > 0) return `no kind string (${String(kind)})`
  return Object.prototype.toString.call(reason)
}

/** The `kind` a value carries, read without letting a hostile accessor escape. */
function readKind(value: object): unknown {
  try {
    return (value as Record<string, unknown>).kind
  } catch {
    // It runs inside `append`: a guard that threw while inspecting a payload
    // would abort the append in the guard rather than in its caller.
    return undefined
  }
}
