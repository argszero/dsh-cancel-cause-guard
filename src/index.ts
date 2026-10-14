/**
 * A prevention guard for the one `turn/end` row that makes a whole conversation
 * view unreadable.
 *
 * ## The defect
 *
 * A plugin calls `agent.cancel(cause)` with a value that is not a member of the
 * closed `AgentCancelCause` union — a bare string such as
 * `agent.cancel('thinking-loop')`, or an object whose `kind` the union does not
 * have. `ReactLoopAgent.cancel` passes it straight to
 * `AbortController.abort(cause)`, so the value becomes `signal.reason`; the
 * turn's `catch` then reads it back through `abortedCancelCause`, whose `switch`
 * ends in `assertNever` — **inside the catch body**. The assignment never runs,
 * `turnEnds` stays at its `null` initializer, and the unconditional `finally`
 * appends `turn/end` with that `null` (`agent-loop/src/agent.ts:385`; the
 * non-null assertion on the line is what makes it compile).
 *
 * Nothing on the write path refuses the row: the append-time validator inspects
 * surface message slots, `request/header` and `tool/result`, and
 * `turn/end.reason` is a TypeScript-only invariant. Every reader that
 * dereferences it then throws — `ui-chat`'s conversation view does
 * `location.turn.end?.data.reason.kind` while rendering — and one such row
 * blanks the entire chat area, for every session, including newly created ones.
 *
 * ## The version boundary
 *
 * A harness older than `0.1.7` had no such function: the turn's `catch` wrote
 * `{ kind: 'aborted', reason: signal.reason }` verbatim, so the same abuse
 * produced a malformed-but-readable row rather than a `null` one. From
 * `0.1.7-rc.2` on, the same abuse is fatal. That is why this is a guard and not
 * a report: the shape of the failure changed under callers that had not changed
 * at all.
 *
 * ## What this plugin does
 *
 * It closes the defect at two depths, and the second one exists for the callers
 * the first cannot see.
 *
 * **At the entry.** It listens to `agent/created` — the serial, awaited lifecycle
 * edge that hands over the **live agent instance** — and shadows that instance's
 * `cancel` with a wrapper that normalizes anything outside the union into
 * `{ kind: 'hook', reason: <the value's own name> }` before the loop ever sees
 * it. `hook` is the union member the harness reserves for plugins, so the
 * rewrite is not a lie: a plugin did cancel the turn, and the reason names which
 * one. One property write covers every instance-level caller — the loop's own
 * `agent.cancel({ kind: 'user' })`, the client's stop button, and any
 * third-party plugin — because `ReactLoopAgent.cancel` is a prototype method and
 * the shadow is an own property.
 *
 * **At the write.** The same edge hands over the **live session**, and the
 * plugin shadows that session's own `append` too, so a `turn/end` row whose
 * reason no reader can dereference is committed instead as the row the loop meant
 * to write: `{ kind: 'aborted', reason: { kind: 'hook', reason: <text> } }`. That
 * arm is what covers the callers the entry guard cannot reach — one that goes
 * through the class rather than the instance
 * (`ReactLoopAgent.prototype.cancel.call(agent, …)`, or a second copy of the loop
 * in the process), and an instance that refuses the own `cancel` property, where
 * the entry guard simply reports that it is not in force. Set `backstop: false`
 * to leave the append path exactly as the harness's.
 *
 * Every rewrite and every repaired row is logged, with the offending value
 * rendered as JSON, so the producer can be found and fixed rather than merely
 * tolerated.
 *
 * ## What it does not do
 *
 * It does not refuse a cancellation, does not touch the options, does not rewrite
 * a cause that is already a member (that one is forwarded by reference), and
 * cannot repair a session that already carries a `null` row — those rows are on
 * disk, and this plugin reads no history. Mounting it bounds the defect from that
 * point on.
 *
 * `mode: 'observe'` exists for the operator who wants to see the failure happen:
 * both arms report and neither rewrites, and the log names what arrived.
 *
 * @module @argszero/dsh-cancel-cause-guard
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the `agent/created` and `agent/disposed` Context merges this plugin listens on.
import type {} from '@deepseek-ai/dsh-agent'
import { guardSessionAppend } from './backstop.ts'
import { resolveConfig } from './config.ts'
import { guardCancel } from './guard.ts'
import type { BackstopHandle, BackstopOptions, Config, GuardHandle, GuardMode, NormalizedCause, RepairedTurnEnd } from './types.ts'

export { DEFAULT_MAX_REASON_CHARS, describeValue, isCancelCause, normalizeCancelCause, reasonText, UNSPECIFIED_REASON } from './cause.ts'
export { APPEND_GUARD_MARK, UNSEEN_CAUSE_REASON, guardSessionAppend, isReadableTurnEndReason, unseenCauseReason } from './backstop.ts'
export { DEFAULTS, resolveConfig } from './config.ts'
export { GUARD_MARK, guardCancel } from './guard.ts'
export type { GuardOptions } from './guard.ts'
export type {
  BackstopHandle,
  BackstopOptions,
  BackstopOutcome,
  Config,
  GuardHandle,
  GuardMode,
  GuardOutcome,
  NormalizedCause,
  RepairedTurnEnd,
  ResolvedConfig,
} from './types.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'cancel-cause-guard'

/**
 * No service is required.
 *
 * The whole seam is the agent instance the lifecycle edge hands over, and asking
 * for a service this plugin does not use would only be a way for it to fail to
 * mount — so the list is empty rather than absent, which keeps the declaration
 * explicit for a reader and identical between the two export forms.
 */
export const inject: readonly string[] = []

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'cancel-cause-guard:'

/**
 * Install the guard.
 * @param ctx - the plugin context; the listener and the restore are disposed
 *   with it.
 * @param config - the configuration as mounted, possibly empty. Defaults are
 *   applied inside `resolveConfig` rather than in a plain object exported under
 *   the name `Config`, because the Loader reads that export as a schema and the
 *   plugin would then fail to mount.
 * @throws when the configuration names an unknown key or an unusable value; the
 *   plugin refuses to mount rather than guarding with rules it cannot honour.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  /** The shadows this plugin installed and has not yet unwound, by agent instance. */
  const guards = new Map<object, AgentShadows>()

  // Registered before the listeners so that it is unwound *after* them: the
  // fiber's effects are disposed in reverse, and unwinding a shadow while a
  // listener could still install another would leave the last one behind.
  ctx.effect(() => () => {
    for (const shadows of guards.values()) restoreShadows(shadows)
    guards.clear()
  }, `${LOG_PREFIX}restore()`)

  ctx.on('agent/created', ({ agent }): undefined => {
    const shadows: AgentShadows = {}
    const sessionId = agent.session.id
    const handle = guardCancel(agent, {
      mode: settings.mode,
      reason: settings.reason,
      maxReasonChars: settings.maxReasonChars,
      onNormalized: report => { reportNormalized(ctx, sessionId, report, settings.mode) },
    })
    switch (handle.outcome) {
      case 'patched':
        shadows.cancel = handle
        ctx.logger.debug(
          `${LOG_PREFIX} agent ${sessionId}: cancellation causes outside the union will be `
          + 'recorded as { kind: "hook", reason } instead of ending the turn with reason null',
        )
        break
      case 'already-guarded':
        ctx.logger.debug(
          `${LOG_PREFIX} agent ${sessionId}: already guarded by this plugin, leaving the `
          + 'existing wrapper in place',
        )
        break
      case 'no-cancel':
        ctx.logger.warn(
          `${LOG_PREFIX} agent ${sessionId} carries no cancel method, so an out-of-union `
          + 'cause from any plugin it hands itself to will still end its turn with reason null',
        )
        break
      /* v8 ignore next 4 -- the read-back check makes both write failures one outcome. */
      case 'not-writable':
        ctx.logger.warn(
          `${LOG_PREFIX} agent ${sessionId} refuses an own "cancel" property, so this guard `
          + 'is NOT in force for it: an out-of-union cause will end its turn with reason null',
        )
    }

    // The durable half, installed after the entry guard so that the ordering is
    // legible: what the entry guard rewrites never reaches this one, and what
    // reaches this one is exactly the cancellation the entry guard could not see.
    if (settings.backstop) {
      const backstop = guardSessionAppend(agent.session, backstopOptions(ctx, sessionId, settings))
      switch (backstop.outcome) {
        case 'patched':
          shadows.append = backstop
          ctx.logger.debug(
            `${LOG_PREFIX} agent ${sessionId}: a turn/end row that reached the log with no `
            + 'readable reason will be recorded as { kind: "aborted", reason: { kind: "hook", reason } }',
          )
          break
        case 'already-guarded':
          ctx.logger.debug(
            `${LOG_PREFIX} agent ${sessionId}: the session is already backstopped by this plugin, `
            + 'leaving the existing wrapper in place',
          )
          break
        case 'no-append':
          ctx.logger.warn(
            `${LOG_PREFIX} agent ${sessionId}: its session carries no append method, so the `
            + 'durable backstop is NOT in force for it',
          )
          break
        /* v8 ignore next 4 -- the read-back check makes both write failures one outcome. */
        case 'not-writable':
          ctx.logger.warn(
            `${LOG_PREFIX} agent ${sessionId}: its session refuses an own "append" property, so `
            + 'the durable backstop is NOT in force for it',
          )
      }
    }

    if (shadows.cancel !== undefined || shadows.append !== undefined) guards.set(agent, shadows)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const shadows = guards.get(agent)
    if (shadows === undefined) return
    restoreShadows(shadows)
    guards.delete(agent)
  })
}

/** The shadows one agent carries: its `cancel`, its session's `append`, or both. */
interface AgentShadows {
  cancel?: GuardHandle | undefined
  append?: BackstopHandle | undefined
}

/**
 * Unwind every shadow of one agent.
 * @param shadows - the handles this plugin installed for that agent.
 */
function restoreShadows(shadows: AgentShadows): void {
  shadows.cancel?.restore()
  shadows.append?.restore()
}

/**
 * The backstop options for one agent.
 * @param ctx - the plugin context, for logging.
 * @param sessionId - the session the backstop reports against.
 * @param settings - the resolved configuration.
 * @returns the options, with the report callback bound.
 */
function backstopOptions(
  ctx: Context,
  sessionId: string,
  settings: { mode: GuardMode; reason: string | undefined; maxReasonChars: number },
): BackstopOptions {
  return {
    mode: settings.mode,
    reason: settings.reason,
    maxReasonChars: settings.maxReasonChars,
    onRepaired: report => { reportRepaired(ctx, sessionId, report, settings.mode) },
  }
}

/**
 * Record one unreadable `turn/end` reason.
 *
 * A warning rather than an error, and deliberately a different sentence from
 * {@link reportNormalized}: this row was not a cause the entry guard rewrote but
 * a cancellation the entry guard never saw, and the operator has to be able to
 * tell the two apart when working out who produced it.
 * @param ctx - the plugin context, for logging.
 * @param sessionId - the session whose row it was.
 * @param report - what the row carried, and what it became.
 * @param mode - whether the row was repaired or passed through.
 */
function reportRepaired(ctx: Context, sessionId: string, report: RepairedTurnEnd, mode: GuardMode): void {
  const outcome = mode === 'observe'
    ? 'it was committed unchanged (mode "observe"), so this session is now unreadable in the chat view'
    : 'it was recorded as '
      + `{ "kind": "aborted", "reason": { "kind": "hook", "reason": ${JSON.stringify(report.normalized.reason)} } }`
  ctx.logger.warn(
    `${LOG_PREFIX} session ${sessionId}: a turn/end row for turn ${String(report.turn)} reached the `
    + `log with a reason no reader can dereference (${report.described}); ${outcome}. `
    + 'The cancellation never passed the entry guard, so its cause is not in this record: a caller '
    + 'reached the cancel method through the class rather than through the instance, a second copy '
    + 'of the loop aborted a signal of its own, or the instance refused the guard.',
  )
}

/**
 * Record one out-of-union cause.
 *
 * A warning rather than an error: what the reader needs is the *name* of the
 * value — the only handle on whoever produced it — and the two modes differ
 * only in what became of it.
 * @param ctx - the plugin context, for logging.
 * @param sessionId - the session whose agent was cancelled.
 * @param report - what was seen, and what it became.
 * @param mode - whether the cause was rewritten or passed through.
 */
function reportNormalized(
  ctx: Context,
  sessionId: string,
  report: NormalizedCause,
  mode: GuardMode,
): void {
  const outcome = mode === 'observe'
    ? 'it was passed through unchanged (mode "observe"), so this turn ends with reason null'
    : 'the turn was recorded as '
      + `{ "kind": "aborted", "reason": { "kind": "hook", "reason": ${JSON.stringify(report.normalized.reason)} } }`
  ctx.logger.warn(
    `${LOG_PREFIX} session ${sessionId}: a caller passed ${report.described} as a cancellation `
    + `cause, which is not a member of AgentCancelCause; ${outcome}. `
    + 'Which plugin passes it is the value itself: the reason carries its own name.',
  )
}

export default { name, inject, apply }
