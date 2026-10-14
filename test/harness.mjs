/**
 * The harness: a REAL cordis context, the REAL `AgentRegistry` from
 * `@deepseek-ai/dsh-agent`, and the plugin mounted the way a profile entry mounts
 * it.
 *
 * Three things are deliberately not simulated:
 *
 * - **The lifecycle edge.** Agents are published through the shipped
 *   `registry.enter()` + `await registry.announce()` path, so `agent/created` is
 *   the real `ctx.serial` dispatch, scope-filtered and awaited exactly as it is
 *   in production. An arm about what this plugin *hears*, built on a hand-rolled
 *   `ctx.emit`, would be an arm about nothing.
 * - **The mount.** `ctx.plugin(plugin, config)` runs the real Loader path, which
 *   is what makes "the plugin mounts at all" (no plain-object `Config` export, no
 *   unusable configuration) a measured claim rather than an assumed one.
 * - **The shape of the method.** `FixtureAgent.cancel` is a **prototype**
 *   method, as `ReactLoopAgent.cancel` is, so every arm that observes the guard
 *   taking effect is observing an own property shadowing a prototype method —
 *   the mechanism the plugin actually relies on.
 *
 * The fourth thing that is not simulated is the **session**: each fixture agent
 * holds a real `@deepseek-ai/dsh-session` `Session`, so the durable backstop's
 * seam (an own property over the prototype `append`) and its consequence (what
 * the log actually ends up carrying) are observed on the shipped class rather
 * than on a stand-in.
 *
 * What is *not* real is the loop itself: the fixture records the cause it was
 * handed instead of aborting a signal and running a turn. The consequence of the
 * cause — `assertNever` inside the turn's catch, and the `reason: null` row that
 * follows — is proved against the published `@deepseek-ai/dsh-agent-loop` source
 * by `scripts/witness-cancel-cause.mjs`, not by a stand-in here.
 *
 * `world({ mounted: false })` is the control arm for every "the plugin guarded
 * this" claim: the same context, the same registry, the same dispatch, with
 * nothing mounted.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import plugin, * as namespace from '../lib/index.js'

/** Both export forms, for the arms that assert each of them mounts. */
export { namespace, plugin }

/** The plugin's own name, as the loader and its diagnostics use it. */
export const PLUGIN_NAME = 'cancel-cause-guard'

/** The prefix every diagnostic this plugin writes starts with. */
export const LOG_PREFIX = `${PLUGIN_NAME}:`

/**
 * Collect every structured log record this process publishes.
 *
 * `levels` is not decoration: an exporter that declares none falls back to the
 * *logger's* own level as its threshold, and this plugin's warnings sit above
 * it, so a capture registered without them silently drops exactly the records
 * these arms assert on.
 * @param ctx - the context whose logger is captured.
 * @returns the records, and a filter over them.
 */
export function captureLogs(ctx) {
  const records = []
  ctx.logger.exporter({
    colors: false,
    levels: { default: 3 },
    export: message => records.push(message),
  })
  return {
    records,
    /** Every captured record of one severity whose format string contains `needle`. */
    matching(needle, type = 'warn') {
      return records.filter(record => record.type === type && String(record.args[0]).includes(needle))
    },
  }
}

/**
 * A live-agent fixture.
 *
 * `cancel` reads nothing but its two arguments, so the arms can see exactly what
 * reached the method — which is the whole question for a guard that sits in front
 * of it.
 */
export class FixtureAgent {
  /**
   * @param id - the session id; `AgentRegistry.enter` requires the agent id and
   *   the session id to be the same value.
   */
  constructor(id) {
    this.id = id
    this.session = Session.create(SessionId(id))
    this.status = 'running'
    /** Every call that reached the method, in order. */
    this.calls = []
  }

  /** Record the call the way the real method's first line records its intent. */
  cancel(cause, options) {
    this.calls.push({ cause, options })
  }
}

/**
 * A live-agent fixture that refuses an own `cancel` property.
 *
 * Stands for any future agent whose instances are frozen — the event map's
 * contract does not promise otherwise, and a guard that silently fails to
 * install would be a guard nobody knows is absent.
 */
export class SealedAgent {
  constructor(id) {
    this.id = id
    this.session = Session.create(SessionId(id))
    this.status = 'running'
    this.calls = []
    // `cancel` deliberately NOT on the instance: the own property below is what
    // the guard tries to write, and it is not writable.
    Object.defineProperty(this, 'cancel', {
      value: (cause, options) => { this.calls.push({ cause, options }) },
      writable: false,
      enumerable: true,
      configurable: false,
    })
    Object.preventExtensions(this)
  }
}

/**
 * Build one world.
 * @param world.mounted - `false` mounts nothing, which is the control arm.
 * @param world.config - the plugin configuration to mount with.
 * @param world.form - which export to mount: the `default` (what a Loader entry
 *   resolves) or the module `namespace`.
 * @returns the context, the log capture, the registry, and the two dispatch
 *   helpers.
 */
export async function world({ mounted = true, config = {}, form = 'default' } = {}) {
  const ctx = new Context()
  const logs = captureLogs(ctx)
  const registry = new AgentRegistry(ctx)
  /** The detach capability each published agent was entered with. */
  const detaches = new WeakMap()

  if (mounted) await ctx.plugin(form === 'namespace' ? namespace : plugin, config)

  return {
    ctx,
    logs,
    registry,
    /** Publish one agent exactly as the shipped registry does: enter, then announce. */
    async announce(agent, source = 'startup') {
      detaches.set(agent, registry.enter(agent, undefined))
      await registry.announce(agent, source)
      return agent
    },
    /** Remove a published agent, which is what emits its paired `agent/disposed`. */
    detach(agent) {
      const detach = detaches.get(agent)
      if (detach === undefined) throw new Error('harness: this agent was never announced here')
      detach()
    },
    /** The recorded calls of one fixture agent. */
    calls: agent => agent.calls,
    /** The durable rows of one fixture agent's real session, in order. */
    rows: agent => agent.session.snapshotEvents(),
  }
}
