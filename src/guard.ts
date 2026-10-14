/**
 * One agent's `cancel`, shadowed so that a cause from outside the closed union
 * never reaches the loop's `assertNever`.
 *
 * ## Why the seam is the instance
 *
 * There is no event on the cancellation path and no hook in the append-time
 * validator: `validateSessionEventData` inspects surface message slots,
 * `request/header` and `tool/result`, and `turn/end.reason` is a TypeScript-only
 * invariant, so nothing on the write path can refuse the row that poisons a
 * session. What the plugin does have is the live agent instance, handed over by
 * `agent/created` — a `ctx.serial` dispatch that `AgentRegistry.announce`
 * **awaits** (`packages/core/agent/src/index.ts:550`), so a listener that
 * settles before its first turn can still change how that agent behaves:
 *
 * ```ts
 * await this.ctx.serial(entry.carrier, 'agent/created', { agent: entry.agent, source, signal })
 * ```
 *
 * `ReactLoopAgent.cancel` is a prototype method (`agent-loop/src/agent.ts:175`),
 * so an **own** property of that name shadows it for every instance-level
 * caller — the loop's own `agent.cancel({ kind: 'user' })`
 * (`agent/src/archive-admission.ts:36`, `agent-loop/src/index.ts:789`), the chat
 * client's stop button, and any third-party plugin. All of them are covered by
 * one property write, which is why this is a guard rather than a per-producer
 * patch.
 *
 * ## What the wrapper does, and what it deliberately does not
 *
 * It normalizes, forwards, and reports — in that order, and nothing else. It
 * does not refuse a cancellation (a plugin that stopped a stop would be worse
 * than the defect), does not touch the options, and does not inspect or rewrite
 * anything but the cause. A value that is already a union member is forwarded
 * **by reference**, so the object the loop reads back out of the signal is the
 * object the caller passed.
 *
 * The wrapper binds the original to the agent it came from. A caller holding a
 * detached `const cancel = agent.cancel` would otherwise have reached the
 * original with no receiver at all; binding it is the reading the method's own
 * body requires (`this.phase`, `this.inbox`), and it makes the shadow more
 * faithful than the property it replaces.
 *
 * @module @argszero/dsh-cancel-cause-guard/guard
 */

import type { Agent, AgentCancelCause, CancelOptions } from '@deepseek-ai/dsh-agent'
import { describeValue, isCancelCause, normalizeCancelCause } from './cause.ts'
import type { GuardHandle, GuardMode, NormalizedCause } from './types.ts'

/**
 * The brand an installed wrapper carries.
 *
 * `Symbol.for` rather than a module-local symbol: two copies of this plugin
 * loaded into one process — the plugin mounted by two profile entries, or a
 * second copy pulled in beside the first — would otherwise each install a
 * wrapper, and the inner one would normalize a cause the outer had already
 * normalized. With a registry-wide key the second mount recognises the first
 * and leaves it alone.
 */
export const GUARD_MARK: unique symbol = Symbol.for('argszero.dsh-cancel-cause-guard/guarded')

/** How one guard is told to behave. */
export interface GuardOptions {
  /** What to do with an out-of-union cause. */
  readonly mode: GuardMode
  /** Reason text to record in place of the value's own name. */
  readonly reason?: string | undefined
  /** Bound on the minted reason text. */
  readonly maxReasonChars: number
  /** Called once per rewritten (or, in `observe` mode, merely reported) cause. */
  readonly onNormalized: (report: NormalizedCause) => void
}

/** The shape a marked wrapper has, for the recognition check. */
type MarkedFunction = ((...args: never[]) => void) & { [GUARD_MARK]?: true }

/**
 * Shadow one agent's `cancel` with a normalizing wrapper.
 *
 * Every refusal is reported as an {@link GuardOutcome} rather than thrown: an
 * agent this plugin could not guard is a session that keeps the defect, not a
 * reason to fail the lifecycle edge that delivered it.
 * @param agent - the live agent instance, as handed over by `agent/created`.
 * @param options - the guard's behaviour and its report callback.
 * @returns the outcome and an undo.
 */
export function guardCancel(agent: Agent, options: GuardOptions): GuardHandle {
  const current: unknown = (agent as { cancel?: unknown }).cancel
  if (typeof current !== 'function') return { outcome: 'no-cancel', restore: () => {} }
  if ((current as MarkedFunction)[GUARD_MARK] === true) {
    return { outcome: 'already-guarded', restore: () => {} }
  }

  const original = current as (cause: AgentCancelCause, cancelOptions?: CancelOptions) => void
  // Whether the property was the instance's own before the guard: a prototype
  // method must be revealed again by deleting the shadow, an own property by
  // writing the old value back. Writing the prototype method back as an own
  // property would look like a successful restore while changing the object.
  const hadOwn = Object.prototype.hasOwnProperty.call(agent, 'cancel')

  const wrapper = function guardedCancel(cause: unknown, cancelOptions?: CancelOptions): void {
    const decided = decide(cause, options)
    Reflect.apply(original, agent, [decided, cancelOptions])
  } as MarkedFunction
  wrapper[GUARD_MARK] = true

  try {
    ;(agent as { cancel: unknown }).cancel = wrapper
  } catch {
    // A sealed instance, or a `cancel` the agent defined without a setter.
    return { outcome: 'not-writable', restore: () => {} }
  }
  // A refusal to write is not always a throw — a frozen object in sloppy mode
  // would simply ignore it — so the install is confirmed by reading it back.
  if ((agent as { cancel?: unknown }).cancel !== wrapper) {
    return { outcome: 'not-writable', restore: () => {} }
  }

  let installed = true
  return {
    outcome: 'patched',
    restore: (): void => {
      if (!installed) return
      installed = false
      // Only unwind a shadow that is still ours: a later guard, or the agent
      // itself, may have replaced it, and undoing that would be a third party's
      // state being written by this one.
      if ((agent as { cancel?: unknown }).cancel !== wrapper) return
      if (hadOwn) (agent as { cancel: unknown }).cancel = original
      else delete (agent as { cancel?: unknown }).cancel
    },
  }
}

/**
 * The cause to forward, and the report that says why.
 * @param cause - the value the caller passed.
 * @param options - the guard's behaviour and its report callback.
 * @returns the value to hand the original `cancel`.
 */
function decide(cause: unknown, options: GuardOptions): unknown {
  if (isCancelCause(cause)) return cause
  const normalized = normalizeCancelCause(cause, {
    reason: options.reason,
    maxReasonChars: options.maxReasonChars,
  })
  options.onNormalized({
    original: cause,
    normalized: normalized as { readonly kind: 'hook'; readonly reason: string },
    described: describeValue(cause, options.maxReasonChars),
  })
  // In `observe` mode the report is the whole contribution: the caller's value
  // goes through untouched, so the turn fails exactly as it would have, and the
  // only difference is that the log now names what produced it.
  return options.mode === 'observe' ? cause : normalized
}
