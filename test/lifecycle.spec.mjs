/**
 * The plugin as it is actually mounted: through a real cordis context, against
 * the real `AgentRegistry`, on the real `agent/created` dispatch.
 *
 * The unit arms prove what the guard does to an object it is handed. These prove
 * the object is handed to it — that the lifecycle edge fires where this plugin
 * listens, that it hands over the **live** instance rather than a copy, that the
 * edge settles before the dispatch returns (which is what makes the guard present
 * before the first turn), and that unmounting leaves nothing behind.
 *
 * `world({ mounted: false })` is the control arm for each of them.
 *
 * @module test/lifecycle.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARD_MARK } from '../lib/index.js'
import { FixtureAgent, LOG_PREFIX, PLUGIN_NAME, namespace, plugin as defaultExport, world } from './harness.mjs'

/** The value three discussions report: a bare string in place of a union member. */
const BAD = 'thinking-loop'

describe('mounting', () => {
  it('mounts with no configuration at all, through the default export the Loader resolves', async () => {
    const w = await world()
    assert.equal(typeof w.ctx.plugin, 'function')
  })

  it('mounts through the module namespace too', async () => {
    const w = await world({ form: 'namespace' })
    const agent = await w.announce(new FixtureAgent('via-namespace'))
    agent.cancel(BAD)
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: BAD })
  })

  it('exposes the shape a loader entry reads, and no plain-object Config', async () => {
    assert.equal(namespace.name, PLUGIN_NAME)
    assert.equal(typeof namespace.apply, 'function')
    assert.deepEqual(namespace.inject, [])
    // A plain object exported under the name `Config` is read as a schema, and the
    // plugin then fails to mount with `reading 'validate'`. The type is exported;
    // the value must not be.
    assert.equal(Object.hasOwn(namespace, 'Config'), false)
    assert.equal(Object.hasOwn(defaultExport, 'Config'), false)
  })

  it('refuses to mount on a configuration it cannot honour', async () => {
    // Mounting with a misspelled knob and guarding nothing is the failure this
    // refusal exists for, so it is asserted through the real mount path.
    await assert.rejects(world({ config: { modes: 'observe' } }), /unknown key "modes"/u)
    await assert.rejects(world({ config: { mode: 'enforce' } }), /mode must be/u)
  })
})

describe('the guard is in place before the agent can be cancelled', () => {
  it('rewrites an out-of-union cause on an agent published after the mount', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('guarded'))
    agent.cancel(BAD)
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: BAD })
  })

  it('leaves the same call alone when nothing is mounted', async () => {
    // The control arm: without it, the arm above would pass on a registry that
    // normalized causes by itself, or on a fixture that recorded the wrong thing.
    const w = await world({ mounted: false })
    const agent = await w.announce(new FixtureAgent('unguarded'))
    agent.cancel(BAD)
    assert.equal(agent.calls[0].cause, BAD)
  })

  it('is already installed when the announce dispatch settles', async () => {
    // `AgentRegistry.announce` awaits the serial `agent/created` dispatch, so a
    // listener registered *after* this plugin sees the guarded instance — which is
    // the same ordering guarantee that puts the guard in place before the agent's
    // first turn can be cancelled.
    const w = await world()
    let sawMark
    w.ctx.on('agent/created', ({ agent }) => { sawMark = agent.cancel[GUARD_MARK] })
    const agent = await w.announce(new FixtureAgent('ordered'))
    assert.equal(sawMark, true)
    assert.equal(agent.cancel[GUARD_MARK], true)
  })

  it('does not touch an agent published before it was mounted', async () => {
    // The honest limit of the seam: an agent created before the plugin mounted
    // keeps the defect until the next mount, and the plugin reads no history.
    const w = await world({ mounted: false })
    const agent = await w.announce(new FixtureAgent('pre-existing'))
    await w.ctx.plugin(defaultExport, {})
    agent.cancel(BAD)
    assert.equal(agent.calls[0].cause, BAD)
  })

  it('covers the loop\u2019s own cancellation as well as a plugin\u2019s', async () => {
    // `archive-admission.ts:36` calls `agent.cancel({ kind: 'user' })` on the
    // instance. A valid member is forwarded by reference, so an ordinary stop is
    // unchanged by the guard being present.
    const w = await world()
    const agent = await w.announce(new FixtureAgent('stop'))
    const cause = { kind: 'user' }
    agent.cancel(cause)
    assert.equal(agent.calls[0].cause, cause)
  })
})

describe('what the log says', () => {
  it('names the value and the session', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('logged'))
    agent.cancel(BAD)

    const warnings = w.logs.matching(`${LOG_PREFIX} session logged:`)
    assert.equal(warnings.length, 1)
    const text = String(warnings[0].args[0])
    // The value itself is the only handle on whoever produced it, so it has to be
    // in the record — quoted, as the discrimination between a string and an object.
    assert.ok(text.includes('"thinking-loop"'), text)
    assert.ok(
      text.includes('{ "kind": "aborted", "reason": { "kind": "hook", "reason": "thinking-loop" } }'),
      text,
    )
  })

  it('says nothing when every cause is a member', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('quiet'))
    agent.cancel({ kind: 'user' })
    agent.cancel({ kind: 'hook', reason: 'whatever' })
    assert.deepEqual(w.logs.matching(LOG_PREFIX), [])
  })

  it('says the cause was passed through, in observe mode', async () => {
    const w = await world({ config: { mode: 'observe' } })
    const agent = await w.announce(new FixtureAgent('observed'))
    agent.cancel(BAD)

    // Both halves matter: the value reached the method (so the operator sees the
    // real failure) and the log says so rather than claiming a repair.
    assert.equal(agent.calls[0].cause, BAD)
    const [warning] = w.logs.matching(`${LOG_PREFIX} session observed:`)
    assert.ok(String(warning.args[0]).includes('passed through unchanged'), String(warning.args[0]))
  })

  it('reports the configured reason override', async () => {
    const w = await world({ config: { reason: 'plugin-bug' } })
    const agent = await w.announce(new FixtureAgent('overridden'))
    agent.cancel(BAD)
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: 'plugin-bug' })
  })
})

describe('a second mount', () => {
  it('recognises the first and does not stack a second wrapper', async () => {
    const w = await world()
    const fork = await w.ctx.plugin(defaultExport, {})
    try {
      const agent = await w.announce(new FixtureAgent('twice'))
      assert.equal(agent.cancel[GUARD_MARK], true)
      agent.cancel(BAD)
      // One rewrite: a stacked wrapper would have reported twice and, in observe
      // mode, would have undone the other one's work.
      assert.equal(agent.calls.length, 1)
      assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: BAD })
      assert.deepEqual(w.logs.matching(`${LOG_PREFIX} agent twice:`), [])
    } finally {
      await fork.dispose()
    }
  })
})

describe('unmounting leaves nothing behind', () => {
  it('restores the instance when the plugin fiber is disposed', async () => {
    const w = await world({ mounted: false })
    const fork = await w.ctx.plugin(defaultExport, {})
    const agent = await w.announce(new FixtureAgent('unmounted'))
    assert.equal(agent.cancel[GUARD_MARK], true)

    await fork.dispose()

    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)
    agent.cancel(BAD)
    assert.equal(agent.calls[0].cause, BAD)
  })

  it('restores the instance when its agent is disposed', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('disposed'))
    assert.equal(agent.cancel[GUARD_MARK], true)

    w.detach(agent)

    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)
    agent.cancel(BAD)
    assert.equal(agent.calls[0].cause, BAD)
  })

  it('leaves an unguarded agent\u2019s disposal alone', async () => {
    // The disposal path runs for every agent; one this plugin never guarded must
    // not be touched by it.
    const w = await world()
    const agent = await w.announce(new FixtureAgent('untouched'))
    w.detach(agent)
    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)
  })
})
