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
import { APPEND_GUARD_MARK, GUARD_MARK, UNSEEN_CAUSE_REASON } from '../lib/index.js'
import { FixtureAgent, LOG_PREFIX, PLUGIN_NAME, SealedAgent, namespace, plugin as defaultExport, world } from './harness.mjs'

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

describe('the durable backstop, on a real Session', () => {
  /**
   * The row the defect leaves, written with the session's own `append`.
   *
   * Nothing here stands in for the harness: `agent.session` is a real
   * `@deepseek-ai/dsh-session` `Session`, so what these arms read back is what
   * `validateSessionEventData` accepted and what the log now carries.
   */
  const nullRow = { turn: 1, reason: null }

  it('keeps the null row out of the log when the plugin is mounted', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('backstopped'))
    assert.equal(agent.session.append[APPEND_GUARD_MARK], true)

    agent.session.append('turn/end', nullRow)

    const [row] = w.rows(agent)
    assert.deepEqual(row.data.reason, { kind: 'aborted', reason: { kind: 'hook', reason: UNSEEN_CAUSE_REASON } })
  })

  it('writes exactly that null row when nothing is mounted', async () => {
    // The control arm, and the defect reproduced in-process against the shipped
    // class: the write path accepts `reason: null` — the append-time validator
    // inspects surface slots, `request/header` and `tool/result` instead — so the
    // row is durable before any reader can object.
    const w = await world({ mounted: false })
    const agent = await w.announce(new FixtureAgent('unbackstopped'))
    agent.session.append('turn/end', nullRow)
    assert.deepEqual(w.rows(agent), [
      { type: 'turn/end', seq: 0, time: w.rows(agent)[0].time, data: { turn: 1, reason: null } },
    ])
  })

  it('covers an agent that refused the own cancel property', async () => {
    // The entry guard's honest limit, closed for the durable half: the instance
    // would not take the shadow, so its cancellation still ends with a null
    // cause, and the row the loop writes for it is still readable.
    const w = await world()
    const agent = await w.announce(new SealedAgent('sealed-append'))
    assert.equal(agent.cancel[GUARD_MARK], undefined)

    agent.session.append('turn/end', { turn: 2, reason: null })

    assert.deepEqual(w.rows(agent)[0].data.reason.kind, 'aborted')
    assert.ok(w.logs.matching(`${LOG_PREFIX} agent sealed-append refuses an own "cancel"`).length === 1)
  })

  it('leaves the append path alone when the backstop is switched off', async () => {
    const w = await world({ config: { backstop: false } })
    const agent = await w.announce(new FixtureAgent('no-backstop'))
    // The entry guard is still in force; only the durable half is off.
    assert.equal(agent.cancel[GUARD_MARK], true)
    assert.equal(Object.prototype.hasOwnProperty.call(agent.session, 'append'), false)

    agent.session.append('turn/end', nullRow)
    assert.equal(w.rows(agent)[0].data.reason, null)
  })

  it('reports the row it repaired, and names it apart from an entry-guard rewrite', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('reported'))
    agent.session.append('turn/end', { turn: 7, reason: null })

    const [warning] = w.logs.matching(`${LOG_PREFIX} session reported:`)
    const text = String(warning.args[0])
    assert.ok(text.includes('turn 7'), text)
    assert.ok(text.includes('never passed the entry guard'), text)
    // And the entry guard's own sentence is a different one, so an operator can
    // tell a rewritten cause from a row the entry guard never saw.
    assert.equal(text.includes('a caller passed'), false)
  })

  it('says nothing when the cause went through the entry guard', async () => {
    const w = await world()
    const agent = await w.announce(new FixtureAgent('quiet-append'))
    agent.cancel(BAD)
    assert.equal(agent.calls[0].cause.kind, 'hook')
    assert.deepEqual(w.logs.matching(`${LOG_PREFIX} session quiet-append: a turn/end row`), [])
  })

  it('reports the row and commits it unchanged in observe mode', async () => {
    const w = await world({ config: { mode: 'observe' } })
    const agent = await w.announce(new FixtureAgent('observed-append'))
    agent.session.append('turn/end', nullRow)

    assert.equal(w.rows(agent)[0].data.reason, null)
    const [warning] = w.logs.matching(`${LOG_PREFIX} session observed-append:`)
    assert.ok(String(warning.args[0]).includes('committed unchanged'), String(warning.args[0]))
  })

  it('does not stack a second wrapper, and restores on both disposal paths', async () => {
    const w = await world({ mounted: false })
    const fork = await w.ctx.plugin(defaultExport, {})
    const agent = await w.announce(new FixtureAgent('append-unmount'))
    assert.equal(agent.session.append[APPEND_GUARD_MARK], true)

    await fork.dispose()
    assert.equal(Object.prototype.hasOwnProperty.call(agent.session, 'append'), false)
    agent.session.append('turn/end', nullRow)
    assert.equal(w.rows(agent)[0].data.reason, null)

    const second = await world({ mounted: false })
    const other = await second.ctx.plugin(defaultExport, {})
    const agent2 = await second.announce(new FixtureAgent('append-disposed'))
    assert.equal(agent2.session.append[APPEND_GUARD_MARK], true)
    second.detach(agent2)
    assert.equal(Object.prototype.hasOwnProperty.call(agent2.session, 'append'), false)
    await other.dispose()
  })

  it('recognises a second mount and reports the row once', async () => {
    const w = await world()
    const fork = await w.ctx.plugin(defaultExport, {})
    try {
      const agent = await w.announce(new FixtureAgent('append-twice'))
      agent.session.append('turn/end', nullRow)
      assert.equal(w.rows(agent).length, 1)
      assert.equal(w.logs.matching(`${LOG_PREFIX} session append-twice:`).length, 1)
    } finally {
      await fork.dispose()
    }
  })
})
