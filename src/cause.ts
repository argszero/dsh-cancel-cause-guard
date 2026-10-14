/**
 * The closed union the harness writes into `turn/end`, and the normalization
 * that makes any other value a member of it.
 *
 * ## Why a value outside the union is not a cosmetic problem
 *
 * `ReactLoopAgent`'s turn body reads the cancellation cause back out of the
 * signal and switches on it (`abortedCancelCause`, `agent-loop/src/agent.ts:80`):
 *
 * ```ts
 * const cause = signal.reason as AgentCancelCause
 * switch (cause.kind) {
 *   case 'user': case 'parent': case 'disposed': return { kind: cause.kind }
 *   case 'hook': return { kind: 'hook', reason: cause.reason }
 *   default: return assertNever(cause)
 * }
 * ```
 *
 * That function is called **inside the turn's `catch`**. A value outside the
 * union therefore throws before the catch body assigns `turnEnds`, which is
 * still its `null` initializer, and the `finally` appends unconditionally:
 *
 * ```ts
 * let turnEnds: TurnEndReason | null = null            // agent.ts:310
 * ...
 * } finally {
 *   this.session.append('turn/end', { turn, reason: turnEnds! })   // agent.ts:385
 * }
 * ```
 *
 * The row lands on disk as `{"type":"turn/end","data":{"turn":N,"reason":null}}`.
 * Nothing rejects it on the way: the append-time validator inspects surface
 * message slots, `request/header` and `tool/result` only, so this field is a
 * TypeScript-only invariant. Readers then dereference it — the chat client does
 * `location.turn.end?.data.reason.kind`
 * (`ui-chat/src/client/contract/turn-process.ts:72`) — and one such row throws
 * while the conversation view renders, which blanks the whole chat area.
 * Reported three times: discussions #8832, #9156 and #9646.
 *
 * ## Two shapes reach it, and only one of them looks like a mistake
 *
 * - an object whose `kind` is missing or unknown (`{ kind: 'thinking-loop' }`),
 *   which `assertNever` refuses; and
 * - a value that is not an object at all — most often `undefined`, from a
 *   caller whose own declaration made the argument optional. `cause.kind` on
 *   `undefined` throws just as effectively, one line earlier.
 *
 * Both are normalized here. `hook` is the member the union reserves for
 * plugins, so a normalized cause says what actually happened: a plugin
 * cancelled the turn, and the reason names which one.
 *
 * @module @argszero/dsh-cancel-cause-guard/cause
 */

import type { AgentCancelCause } from '@deepseek-ai/dsh-agent'

/** Bound on a minted reason when the configuration names none. */
export const DEFAULT_MAX_REASON_CHARS = 200

/** The reason text standing in for a cause that carried no name at all. */
export const UNSPECIFIED_REASON = 'unspecified'

/** The union member a value from outside the union is carried under. */
export const CARRIER_KIND = 'hook'

/** How one normalization is parameterized. */
export interface NormalizeOptions {
  /** Reason text to record, in place of the value's own name. */
  readonly reason?: string | undefined
  /** Bound on the minted reason text. */
  readonly maxReasonChars?: number | undefined
}

/**
 * Whether a value is already exactly one of the four union members.
 *
 * `hook` is held to the stricter test: its `reason` is part of the member's
 * contract, and a `hook` whose reason is not a string is normalized rather than
 * passed through, so that everything downstream of this plugin can rely on the
 * field being text.
 * @param cause - the value a caller passed to `Agent.cancel`.
 * @returns whether the value can be recorded as-is.
 */
export function isCancelCause(cause: unknown): cause is AgentCancelCause {
  switch (readKind(cause)) {
    case 'user':
    case 'parent':
    case 'disposed':
      return true
    case 'hook':
      return typeof readField(cause, 'reason') === 'string'
    default:
      return false
  }
}

/**
 * Turn any cancellation cause into a member of the closed union.
 *
 * A value that is already a member is returned **unchanged** (same reference),
 * so the common path allocates nothing and an `{ kind: 'user' }` a caller may
 * still be holding is the object the loop reads back.
 * @param cause - the value a caller passed to `Agent.cancel`.
 * @param options - the reason override and the reason bound.
 * @returns a member of `AgentCancelCause`.
 */
export function normalizeCancelCause(cause: unknown, options: NormalizeOptions = {}): AgentCancelCause {
  if (isCancelCause(cause)) return cause
  const limit = options.maxReasonChars ?? DEFAULT_MAX_REASON_CHARS
  if (options.reason !== undefined && options.reason.length > 0) {
    return { kind: CARRIER_KIND, reason: truncate(options.reason, limit) }
  }
  if (readKind(cause) === CARRIER_KIND) {
    // The member is right; only its reason field is not text.
    return { kind: CARRIER_KIND, reason: reasonText(readField(cause, 'reason'), limit) }
  }
  return { kind: CARRIER_KIND, reason: reasonText(cause, limit) }
}

/**
 * The reason text for one value, preferring whatever name it carried.
 *
 * The preference order is deliberate: a caller that passed
 * `{ kind: 'thinking-loop' }` meant the token `thinking-loop`, and a reason
 * reading `thinking-loop` is more useful to the person reading the session than
 * the JSON it was embedded in.
 * @param value - the value to name, or the reason field of a `hook` cause.
 * @param maxChars - bound on the result.
 * @returns a non-empty, bounded string.
 */
export function reasonText(value: unknown, maxChars: number = DEFAULT_MAX_REASON_CHARS): string {
  if (typeof value === 'string') {
    return value.trim().length === 0 ? UNSPECIFIED_REASON : truncate(value, maxChars)
  }
  if (value === undefined || value === null) return UNSPECIFIED_REASON
  const named = carriedKind(value)
  if (named !== undefined) return truncate(named, maxChars)
  return truncate(plainText(value), maxChars)
}

/**
 * A descriptive rendering of a value for a log line.
 *
 * Separate from {@link reasonText} because the log is read by whoever has to
 * find the producer, and there the JSON of the offending value is the useful
 * form — including the `undefined` that {@link reasonText} deliberately hides
 * behind `unspecified`.
 * @param value - the value to describe.
 * @param maxChars - bound on the result.
 * @returns a bounded, single-line rendering.
 */
export function describeValue(value: unknown, maxChars: number = DEFAULT_MAX_REASON_CHARS): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return truncate(JSON.stringify(value), maxChars)
  return truncate(plainText(value), maxChars)
}

/** The `kind` a value carries, when that is a non-empty string. */
function carriedKind(value: unknown): string | undefined {
  const kind = readKind(value)
  return typeof kind === 'string' && kind.trim().length > 0 ? kind : undefined
}

/**
 * One field of a value, read without letting a hostile accessor escape.
 *
 * It runs inside `cancel`: a guard that threw on the way to naming a cause would
 * abort the turn in the guard rather than in its caller, which is strictly worse
 * than the defect. A value whose `kind` cannot be read is therefore treated as a
 * value with no `kind` at all.
 */
function readField(value: unknown, field: 'kind' | 'reason'): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    return (value as Record<string, unknown>)[field]
  } catch {
    return undefined
  }
}

/** The `kind` a value carries, read through {@link readField}. */
function readKind(value: unknown): unknown {
  return readField(value, 'kind')
}

/** A string for any value, never throwing on the ones JSON refuses. */
function plainText(value: unknown): string {
  if (typeof value === 'function') return `function ${(value as { name?: string }).name ?? ''}`.trim()
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string' && json.length > 0) return json
  } catch {
    // A circular structure, a BigInt, or a throwing `toJSON`.
  }
  try {
    return String(value)
  } catch {
    // A proxy or an object whose `toString` is itself hostile. This module runs
    // inside `cancel`, and a guard that threw while naming a cause would be the
    // defect it exists to prevent.
    return UNSPECIFIED_REASON
  }
}

/**
 * Bound one reason so a hostile value cannot write a wall of text into the log.
 * Shared with the durable backstop, which mints a reason of its own.
 * @param text - the reason text.
 * @param maxChars - the bound, in characters.
 * @returns the text, cut to the bound with a trailing ellipsis when it had to be.
 */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}
