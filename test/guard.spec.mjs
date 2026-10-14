/**
 * The seam itself: one property write on one live agent, and everything that must
 * and must not follow from it.
 *
 * These arms are about the mechanism rather than about the rewrite — that the
 * shadow really is an own property over a prototype method, that it forwards the
 * options it was handed, that it binds the original to the agent it came from,
 * and that undoing it leaves the object exactly as it was found. A guard whose
 * install leaks, whose restore writes a prototype method in as an own property,
 * or that forgets to pass the caller's options would each change how a
 * cancellation behaves for reasons nobody asked for.
 *
 * @module test/guard.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARD_MARK, guardCancel } from '../lib/index.js'

/** The shape `ReactLoopAgent` has: `cancel` on the prototype, instances extensible. */
class Agent {
  constructor(id = 'guard-spec') {
    this.id = id
    this.session = { id }
    this.status = 'running'
    this.calls = []
  }

  cancel(cause, options) {
    this.calls.push({ cause, options })
  }
}

/** A guard whose report callback is captured, so the arms can read what it saw. */
function guard(agent, overrides = {}) {
  const reports = []
  const handle = guardCancel(agent, {
    mode: 'normalize',
    reason: undefined,
    maxReasonChars: 200,
    onNormalized: report => reports.push(report),
    ...overrides,
  })
  return { handle, reports }
}

describe('installing the shadow', () => {
  it('puts an own property over the prototype method', () => {
    const agent = new Agent()
    const prototypeMethod = Object.getPrototypeOf(agent).cancel
    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)

    const { handle } = guard(agent)

    assert.equal(handle.outcome, 'patched')
    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), true)
    assert.notEqual(agent.cancel, prototypeMethod)
    // The prototype is untouched: this is a shadow, not a patch of the class.
    assert.equal(Object.getPrototypeOf(agent).cancel, prototypeMethod)
  })

  it('rewrites an out-of-union cause before the original sees it', () => {
    const agent = new Agent()
    const { handle, reports } = guard(agent)
    agent.cancel('thinking-loop')

    assert.equal(agent.calls.length, 1)
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: 'thinking-loop' })
    assert.deepEqual(reports, [{
      original: 'thinking-loop',
      normalized: { kind: 'hook', reason: 'thinking-loop' },
      described: '"thinking-loop"',
    }])
    assert.equal(handle.outcome, 'patched')
  })

  it('forwards a valid cause by reference, without reporting it', () => {
    const agent = new Agent()
    const cause = { kind: 'user' }
    const { reports } = guard(agent)
    agent.cancel(cause)

    assert.equal(agent.calls[0].cause, cause)
    assert.deepEqual(reports, [])
  })

  it('hands the options through untouched', () => {
    const agent = new Agent()
    const options = { keepInbox: true }
    guard(agent)
    agent.cancel({ kind: 'parent' }, options)
    assert.equal(agent.calls[0].options, options)
  })

  it('passes undefined options through as undefined, keeping the method default', () => {
    const agent = new Agent()
    guard(agent)
    agent.cancel({ kind: 'disposed' })
    // The wrapper always calls with two arguments; the original's own
    // `options = {}` default is what must still apply.
    assert.equal(agent.calls[0].options, undefined)
  })

  it('binds the original to the agent even when the method is called detached', () => {
    const agent = new Agent()
    guard(agent)
    const detached = agent.cancel
    detached('thinking-loop')
    assert.equal(agent.calls.length, 1)
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: 'thinking-loop' })
  })

  it('marks the wrapper so a second mount recognises it', () => {
    const agent = new Agent()
    const { handle } = guard(agent)
    assert.equal(agent.cancel[GUARD_MARK], true)
    assert.equal(handle.outcome, 'patched')

    const second = guard(agent)
    assert.equal(second.handle.outcome, 'already-guarded')
  })

  it('does not double-normalize when a second guard mounts anyway', () => {
    const agent = new Agent()
    guard(agent)
    agent.cancel({ kind: 'thinking-loop' })
    // One rewrite, not a reason of a reason.
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: 'thinking-loop' })
    assert.equal(String(agent.calls[0].cause.reason).includes('"kind"'), false)
  })
})

describe('the refusals', () => {
  it('reports an instance with no cancel at all', () => {
    const bare = { id: 'bare', session: { id: 'bare' }, status: 'running' }
    const { handle, reports } = guard(bare)
    assert.equal(handle.outcome, 'no-cancel')
    assert.deepEqual(reports, [])
    // And the undo is a no-op rather than a delete of something that never was.
    assert.doesNotThrow(() => handle.restore())
  })

  it('reports a non-callable cancel as no-cancel', () => {
    const odd = { id: 'odd', session: { id: 'odd' }, status: 'running', cancel: 'nope' }
    assert.equal(guard(odd).handle.outcome, 'no-cancel')
  })

  it('reports an instance that refuses the write', () => {
    // The event map's contract does not promise extensible instances, and a guard
    // that silently failed to install would be a guard nobody knows is absent.
    const sealed = { id: 'sealed', session: { id: 'sealed' }, status: 'running' }
    Object.defineProperty(sealed, 'cancel', {
      value: () => {},
      writable: false,
      configurable: false,
    })
    Object.preventExtensions(sealed)
    const { handle } = guard(sealed)
    assert.equal(handle.outcome, 'not-writable')
    assert.doesNotThrow(() => handle.restore())
  })
})

describe('the undo', () => {
  it('reveals the prototype method again rather than copying it in', () => {
    const agent = new Agent()
    const prototypeMethod = Object.getPrototypeOf(agent).cancel
    const { handle } = guard(agent)
    handle.restore()

    // Deleting the shadow is what makes the object identical to how it was found;
    // writing the prototype method in as an own property would look equivalent
    // and change the object.
    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)
    assert.equal(agent.cancel, prototypeMethod)
  })

  it('restores an own property that was there before the guard', () => {
    const agent = new Agent()
    const own = function ownCancel(cause) { this.calls.push({ cause, options: 'own' }) }
    agent.cancel = own
    const { handle } = guard(agent)
    assert.notEqual(agent.cancel, own)
    handle.restore()
    assert.equal(agent.cancel, own)
  })

  it('is single-shot', () => {
    const agent = new Agent()
    const { handle } = guard(agent)
    const patched = agent.cancel
    handle.restore()
    handle.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(agent, 'cancel'), false)
    assert.notEqual(agent.cancel, patched)
  })

  it('leaves a later wrapper of somebody else\u2019s in place', () => {
    const agent = new Agent()
    const { handle } = guard(agent)
    const replacement = () => {}
    agent.cancel = replacement
    handle.restore()
    assert.equal(agent.cancel, replacement)
  })
})

describe('observe mode', () => {
  it('reports the value and forwards it unchanged', () => {
    const agent = new Agent()
    const { handle, reports } = guard(agent, { mode: 'observe' })
    assert.equal(handle.outcome, 'patched')

    agent.cancel('thinking-loop')

    // The caller's value reaches the method, so the turn fails exactly as it would
    // without the plugin; the plugin's whole contribution is the report.
    assert.equal(agent.calls[0].cause, 'thinking-loop')
    assert.equal(reports.length, 1)
    assert.equal(reports[0].original, 'thinking-loop')
  })

  it('reports nothing for a cause that is already a member', () => {
    const agent = new Agent()
    const { reports } = guard(agent, { mode: 'observe' })
    agent.cancel({ kind: 'user' })
    assert.deepEqual(reports, [])
  })
})

describe('the reason override and bound reach the wrapper', () => {
  it('uses the configured reason for a rewritten cause', () => {
    const agent = new Agent()
    guard(agent, { reason: 'plugin-bug' })
    agent.cancel('thinking-loop')
    assert.deepEqual(agent.calls[0].cause, { kind: 'hook', reason: 'plugin-bug' })
  })

  it('bounds the reason the wrapper mints', () => {
    const agent = new Agent()
    guard(agent, { maxReasonChars: 8 })
    agent.cancel('a'.repeat(100))
    assert.equal(agent.calls[0].cause.reason.length, 8)
  })

  it('bounds the description the report carries', () => {
    const agent = new Agent()
    const { reports } = guard(agent, { maxReasonChars: 12 })
    agent.cancel({ kind: 'x'.repeat(200) })
    assert.equal(reports[0].described.length, 12)
  })
})
