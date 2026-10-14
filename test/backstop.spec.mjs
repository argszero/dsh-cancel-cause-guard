/**
 * The durable backstop: the seam, and the invariant it holds.
 *
 * The entry guard can only cover callers that go through the agent **instance**.
 * A caller that reaches the class (`ReactLoopAgent.prototype.cancel.call(agent, …)`),
 * a second copy of the loop in one process, or an instance that refuses the own
 * `cancel` property all end the same way: `abortedCancelCause`'s `assertNever`
 * throws inside the turn's `catch`, `turnEnds` stays `null`, and the
 * unconditional `finally` commits `{"type":"turn/end","data":{"turn":N,"reason":null}}`.
 *
 * These arms are about the second seam — an own property over the session's
 * prototype `append` — and about the one invariant it holds: a `turn/end` row
 * whose reason no reader can dereference never reaches the log with that reason.
 * The row it writes instead is the row the loop meant to write, so the end-to-end
 * consequence is asserted against a real `Session` in `lifecycle.spec.mjs`.
 *
 * @module test/backstop.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APPEND_GUARD_MARK, UNSEEN_CAUSE_REASON, guardSessionAppend, isReadableTurnEndReason } from '../lib/index.js'

/** The shape a real `Session` has: `append` on the prototype, instances extensible. */
class Store {
  constructor() {
    /** Every call that reached the method, as it reached it. */
    this.rows = []
  }

  append(type, data, ...opts) {
    this.rows.push({ type, data, opts })
    return { type, data }
  }
}

/** A backstop whose report callback is captured, so the arms can read what it saw. */
function backstop(session, overrides = {}) {
  const reports = []
  const handle = guardSessionAppend(session, {
    mode: 'normalize',
    reason: undefined,
    maxReasonChars: 200,
    onRepaired: report => reports.push(report),
    ...overrides,
  })
  return { handle, reports, store: session }
}

/** The row the backstop is expected to write for a cancellation it never saw. */
function expectedRow(reason = UNSEEN_CAUSE_REASON) {
  return { kind: 'aborted', reason: { kind: 'hook', reason } }
}

describe('installing the shadow', () => {
  it('puts an own property over the prototype method', () => {
    const session = new Store()
    const prototypeMethod = Object.getPrototypeOf(session).append
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), false)

    const { handle } = backstop(session)

    assert.equal(handle.outcome, 'patched')
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), true)
    assert.notEqual(session.append, prototypeMethod)
    // The prototype is untouched: this is a shadow, not a patch of the class.
    assert.equal(Object.getPrototypeOf(session).append, prototypeMethod)
  })

  it('marks the wrapper so a second mount recognises it', () => {
    const session = new Store()
    assert.equal(backstop(session).handle.outcome, 'patched')
    assert.equal(session.append[APPEND_GUARD_MARK], true)
    assert.equal(backstop(session).handle.outcome, 'already-guarded')
  })

  it('forwards every argument past the two it inspects', () => {
    const session = new Store()
    backstop(session)
    const opts = { surfaceOp: 'append', sourceEventSeqs: [3] }
    session.append('tool/result', { id: 'c1' }, opts)
    assert.equal(session.rows[0].opts[0], opts)
    assert.deepEqual(session.rows[0].data, { id: 'c1' })
  })
})

describe('what it repairs', () => {
  it('rewrites the row the defect leaves: turn/end with reason null', () => {
    const session = new Store()
    const { reports } = backstop(session)

    session.append('turn/end', { turn: 4, reason: null })

    assert.deepEqual(session.rows[0].data, { turn: 4, reason: expectedRow() })
    assert.deepEqual(reports, [{
      turn: 4,
      original: null,
      normalized: { kind: 'hook', reason: UNSEEN_CAUSE_REASON },
      described: 'null',
    }])
  })

  it('rewrites a row whose reason is absent altogether', () => {
    const session = new Store()
    const { reports } = backstop(session)
    session.append('turn/end', { turn: 1 })
    assert.deepEqual(session.rows[0].data, { turn: 1, reason: expectedRow() })
    // Named apart from a row that carried an explicit null: the log has to say
    // which of the two arrived.
    assert.equal(reports[0].described, 'absent')
  })

  it('rewrites a reason that is not an object at all', () => {
    // The readers dereference `reason.kind`; a string has no `kind`, and the
    // switches downstream of that expression treat the miss as an unknown shape.
    const session = new Store()
    const { reports } = backstop(session)
    session.append('turn/end', { turn: 2, reason: 'aborted' })
    assert.deepEqual(session.rows[0].data, { turn: 2, reason: expectedRow() })
    assert.equal(reports[0].described, '[object String]')
  })

  it('rewrites a reason whose kind is not a string', () => {
    const session = new Store()
    backstop(session)
    session.append('turn/end', { turn: 2, reason: { kind: 7 } })
    assert.deepEqual(session.rows[0].data, { turn: 2, reason: expectedRow() })
  })

  it('keeps the rest of the payload', () => {
    const session = new Store()
    backstop(session)
    session.append('turn/end', { turn: 9, reason: null, pluginField: 'kept' })
    assert.deepEqual(session.rows[0].data, { turn: 9, reason: expectedRow(), pluginField: 'kept' })
  })

  it('does not mutate the payload the caller passed', () => {
    // `append` snapshots what it is handed; a backstop that edited the caller's
    // object would be writing into a value that is not its own.
    const session = new Store()
    backstop(session)
    const data = { turn: 3, reason: null }
    session.append('turn/end', data)
    assert.deepEqual(data, { turn: 3, reason: null })
  })
})

describe('what it leaves alone', () => {
  it('forwards a readable reason by reference', () => {
    const session = new Store()
    const { reports } = backstop(session)
    const data = { turn: 1, reason: { kind: 'completed' } }
    session.append('turn/end', data)
    assert.equal(session.rows[0].data, data)
    assert.deepEqual(reports, [])
  })

  it('forwards a variant this plugin has never heard of', () => {
    // `TurnEndReasonMap` is merge-extensible, so a plugin's own variant is a
    // legitimate row and must not be rewritten by a plugin that cannot enumerate
    // the map.
    const session = new Store()
    const { reports } = backstop(session)
    const data = { turn: 1, reason: { kind: 'my-plugin-stopped-it' } }
    session.append('turn/end', data)
    assert.equal(session.rows[0].data, data)
    assert.deepEqual(reports, [])
  })

  it('forwards every other event type untouched, whatever it carries', () => {
    const session = new Store()
    const { reports } = backstop(session)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('session/end-seed', {})
    // A null in some other event is not this plugin's business.
    session.append('plugin/record', { reason: null })
    assert.equal(session.rows.length, 4)
    assert.deepEqual(reports, [])
    assert.equal(Object.prototype.hasOwnProperty.call(session.rows[3].data, 'reason'), true)
  })

  it('forwards a turn/end payload that is not an object', () => {
    // Rebuilding a payload the event map does not promise would be inventing a
    // row; reporting it and letting it through leaves the failure where it is.
    const session = new Store()
    const { reports } = backstop(session)
    session.append('turn/end', 'nonsense')
    assert.equal(session.rows[0].data, 'nonsense')
    assert.deepEqual(reports, [])
  })
})

describe('observe mode', () => {
  it('reports the row and commits it unchanged', () => {
    const session = new Store()
    const { reports } = backstop(session, { mode: 'observe' })
    session.append('turn/end', { turn: 5, reason: null })

    assert.deepEqual(session.rows[0].data, { turn: 5, reason: null })
    assert.equal(reports.length, 1)
    assert.equal(reports[0].turn, 5)
  })
})

describe('the reason override and the bound', () => {
  it('records the configured reason instead of the default text', () => {
    const session = new Store()
    backstop(session, { reason: 'plugin-bug' })
    session.append('turn/end', { turn: 1, reason: null })
    assert.deepEqual(session.rows[0].data.reason, expectedRow('plugin-bug'))
  })

  it('bounds the reason it mints', () => {
    const session = new Store()
    backstop(session, { maxReasonChars: 8 })
    session.append('turn/end', { turn: 1, reason: null })
    // `data.reason` is the turn ending, whose own `reason` is the cause, whose
    // own `reason` is the text: `{ kind: 'aborted', reason: { kind: 'hook', reason } }`.
    assert.equal(session.rows[0].data.reason.reason.reason.length, 8)
  })
})

describe('the refusals', () => {
  it('reports a session that is absent', () => {
    for (const nothing of [undefined, null]) {
      const { handle } = backstop(nothing)
      assert.equal(handle.outcome, 'no-append')
      assert.doesNotThrow(() => handle.restore())
    }
  })

  it('reports a session with no append at all', () => {
    assert.equal(backstop({ id: 'bare' }).handle.outcome, 'no-append')
  })

  it('reports a non-callable append', () => {
    assert.equal(backstop({ id: 'odd', append: 'nope' }).handle.outcome, 'no-append')
  })

  it('reports a session that refuses the write', () => {
    const sealed = { id: 'sealed' }
    Object.defineProperty(sealed, 'append', {
      value: () => {},
      writable: false,
      configurable: false,
    })
    Object.preventExtensions(sealed)
    const { handle } = backstop(sealed)
    assert.equal(handle.outcome, 'not-writable')
    assert.doesNotThrow(() => handle.restore())
  })
})

describe('the undo', () => {
  it('reveals the prototype method again rather than copying it in', () => {
    const session = new Store()
    const prototypeMethod = Object.getPrototypeOf(session).append
    const { handle } = backstop(session)
    handle.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), false)
    assert.equal(session.append, prototypeMethod)
  })

  it('restores an own property that was there before the backstop', () => {
    const session = new Store()
    const own = function ownAppend() { return 'own' }
    session.append = own
    const { handle } = backstop(session)
    assert.notEqual(session.append, own)
    handle.restore()
    assert.equal(session.append, own)
  })

  it('is single-shot, and leaves a later wrapper of somebody else\u2019s in place', () => {
    const session = new Store()
    const { handle } = backstop(session)
    const patched = session.append
    handle.restore()
    handle.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), false)

    const replacement = () => {}
    backstop(session).handle.restore()
    session.append = replacement
    handle.restore()
    assert.equal(session.append, replacement)
    assert.notEqual(session.append, patched)
  })
})

describe('the readability predicate', () => {
  it('accepts exactly what a reader can dereference', () => {
    for (const good of [{ kind: 'completed' }, { kind: 'error', error: {} }, { kind: 'x' }]) {
      assert.equal(isReadableTurnEndReason(good), true, JSON.stringify(good))
    }
    for (const bad of [null, undefined, 'aborted', 7, {}, { kind: '' }, { kind: '   ' }, [], true]) {
      assert.equal(isReadableTurnEndReason(bad), false, JSON.stringify(bad))
    }
  })

  it('survives a reason whose kind cannot be read', () => {
    // It runs inside `append`: a backstop that threw while inspecting a payload
    // would abort the append in the guard rather than in its caller.
    const hostile = {}
    Object.defineProperty(hostile, 'kind', { get() { throw new Error('no kind for you') } })
    assert.equal(isReadableTurnEndReason(hostile), false)
  })
})
