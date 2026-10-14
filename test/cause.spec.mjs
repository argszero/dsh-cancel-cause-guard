/**
 * The pure half: what a value becomes, and what it is called.
 *
 * These arms are the ones that keep the guard from being worse than the defect.
 * A normalizer that dropped a valid cause, rewrote one it was handed by
 * reference, mangles a `hook` whose reason is not text, or throws while naming
 * something it does not understand would each turn a working cancellation into a
 * different failure — and every one of them is invisible in the log unless an
 * arm says otherwise.
 *
 * @module test/cause.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_MAX_REASON_CHARS,
  UNSPECIFIED_REASON,
  describeValue,
  isCancelCause,
  normalizeCancelCause,
  reasonText,
} from '../lib/index.js'

const USER = { kind: 'user' }
const PARENT = { kind: 'parent' }
const DISPOSED = { kind: 'disposed' }
const HOOK = { kind: 'hook', reason: 'deepseek-account/signed-out' }

describe('the members of the union', () => {
  it('recognises all four, and refuses everything else', () => {
    for (const member of [USER, PARENT, DISPOSED, HOOK]) assert.equal(isCancelCause(member), true)
    for (const other of ['user', 'thinking-loop', {}, null, undefined, 7, { kind: 7 }]) {
      assert.equal(isCancelCause(other), false, `${String(other)} must not pass as a member`)
    }
    // A member with an extra field is still the member: the union is structural,
    // and refusing it would rewrite a cause that was already valid.
    assert.equal(isCancelCause({ kind: 'user', extra: 1 }), true)
  })

  it('refuses a hook whose reason is not text', () => {
    // The field is part of that member's contract: everything downstream of this
    // plugin reads `reason` as a string, and a `hook` carrying `undefined` would
    // move the failure instead of preventing it.
    assert.equal(isCancelCause({ kind: 'hook' }), false)
    assert.equal(isCancelCause({ kind: 'hook', reason: 7 }), false)
    assert.equal(isCancelCause({ kind: 'hook', reason: '' }), true)
  })

  it('forwards every member by reference, allocating nothing', () => {
    for (const member of [USER, PARENT, DISPOSED, HOOK]) {
      assert.equal(normalizeCancelCause(member), member)
    }
  })
})

describe('what an out-of-union cause becomes', () => {
  it('carries a bare string as the reason', () => {
    // The shape that produced the reports: `agent.cancel('thinking-loop')`.
    assert.deepEqual(normalizeCancelCause('thinking-loop'), { kind: 'hook', reason: 'thinking-loop' })
  })

  it('prefers the name the value carried over its JSON', () => {
    // `{ kind: 'thinking-loop' }` means the token, and a reason reading the token
    // is what a person can act on.
    assert.deepEqual(normalizeCancelCause({ kind: 'thinking-loop' }), {
      kind: 'hook',
      reason: 'thinking-loop',
    })
  })

  it('names the absence when there is no name at all', () => {
    // The second shape: a caller whose own declaration made the argument
    // optional. `cause.kind` on `undefined` throws one line before `assertNever`.
    for (const nothing of [undefined, null]) {
      assert.deepEqual(normalizeCancelCause(nothing), { kind: 'hook', reason: UNSPECIFIED_REASON })
    }
  })

  it('falls back to the value itself when it has neither name nor JSON', () => {
    const circular = {}
    circular.self = circular
    assert.deepEqual(normalizeCancelCause(circular), {
      kind: 'hook',
      reason: describeValue(circular),
    })
    assert.deepEqual(normalizeCancelCause(7n), { kind: 'hook', reason: '7' })
    assert.deepEqual(normalizeCancelCause(Symbol('cancel')), {
      kind: 'hook',
      reason: describeValue(Symbol('cancel')),
    })
  })

  it('never throws, whatever it is handed', () => {
    // It runs inside `cancel`: an exception here would abort a turn in the guard
    // rather than in the caller.
    const hostile = { get kind() { throw new Error('kind getter') } }
    assert.equal(normalizeCancelCause(hostile).kind, 'hook')
    const trap = new Proxy({}, { ownKeys() { throw new Error('proxy') } })
    assert.equal(normalizeCancelCause(trap).kind, 'hook')
    const throwingToString = { toString() { throw new Error('toString') }, toJSON() { throw new Error('toJSON') } }
    assert.deepEqual(normalizeCancelCause(throwingToString), {
      kind: 'hook',
      reason: UNSPECIFIED_REASON,
    })
  })

  it('repairs a hook whose reason is not text rather than dropping it', () => {
    assert.deepEqual(normalizeCancelCause({ kind: 'hook' }), {
      kind: 'hook',
      reason: UNSPECIFIED_REASON,
    })
    assert.deepEqual(normalizeCancelCause({ kind: 'hook', reason: 7 }), { kind: 'hook', reason: '7' })
  })

  it('keeps an empty-string reason out of the result', () => {
    assert.deepEqual(normalizeCancelCause({ kind: 'hook', reason: '' }), {
      kind: 'hook',
      reason: '',
    })
    // A blank *string* cause is different: there the string IS the value, and a
    // blank one names nothing.
    assert.deepEqual(normalizeCancelCause('   '), { kind: 'hook', reason: UNSPECIFIED_REASON })
  })
})

describe('the configured override', () => {
  it('replaces the name for every rewritten cause', () => {
    assert.deepEqual(normalizeCancelCause('thinking-loop', { reason: 'plugin-bug' }), {
      kind: 'hook',
      reason: 'plugin-bug',
    })
    assert.deepEqual(normalizeCancelCause(undefined, { reason: 'plugin-bug' }), {
      kind: 'hook',
      reason: 'plugin-bug',
    })
  })

  it('does not touch a cause that is already a member', () => {
    // The override is for rewritten values only; a valid member is forwarded by
    // reference, so it cannot silently acquire this plugin's reason.
    assert.equal(normalizeCancelCause(USER, { reason: 'plugin-bug' }), USER)
    assert.equal(normalizeCancelCause(HOOK, { reason: 'plugin-bug' }), HOOK)
  })

  it('is ignored when it is an empty string, because resolveConfig refuses those', () => {
    assert.deepEqual(normalizeCancelCause('thinking-loop', { reason: '' }), {
      kind: 'hook',
      reason: 'thinking-loop',
    })
  })
})

describe('the reason bound', () => {
  it('truncates to the configured length, ellipsis included', () => {
    const long = 'x'.repeat(500)
    const { reason } = normalizeCancelCause(long, { maxReasonChars: 10 })
    assert.equal(reason.length, 10)
    assert.equal(reason, `${'x'.repeat(9)}\u2026`)
  })

  it('leaves a reason exactly at the bound alone', () => {
    const exact = 'y'.repeat(10)
    assert.equal(normalizeCancelCause(exact, { maxReasonChars: 10 }).reason, exact)
  })

  it('defaults to 200 characters', () => {
    assert.equal(DEFAULT_MAX_REASON_CHARS, 200)
    assert.equal(normalizeCancelCause('z'.repeat(500)).reason.length, 200)
  })

  it('bounds the override as well as the value it replaces', () => {
    assert.equal(normalizeCancelCause('short', { reason: 'w'.repeat(300), maxReasonChars: 12 }).reason.length, 12)
  })
})

describe('the descriptions', () => {
  it('renders the values a log reader has to tell apart', () => {
    assert.equal(describeValue(undefined), 'undefined')
    assert.equal(describeValue(null), 'null')
    // A string is quoted, so an empty one is visibly empty rather than absent.
    assert.equal(describeValue(''), '""')
    assert.equal(describeValue('thinking-loop'), '"thinking-loop"')
    assert.equal(describeValue({ kind: 'thinking-loop' }), '{"kind":"thinking-loop"}')
  })

  it('answers for a value whose name is carried as a non-empty kind', () => {
    assert.equal(reasonText({ kind: 'turn-budget' }), 'turn-budget')
    assert.equal(reasonText({ kind: '   ' }), '{"kind":"   "}')
    assert.equal(reasonText({ reason: 'hook-style' }), '{"reason":"hook-style"}')
  })

  it('prefers an explicit string over a JSON rendering', () => {
    assert.equal(reasonText('kept as written'), 'kept as written')
    assert.equal(reasonText(''), UNSPECIFIED_REASON)
  })
})
