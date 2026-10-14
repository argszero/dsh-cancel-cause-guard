/**
 * Configuration resolution: the defaults, and the four ways a configuration is
 * refused.
 *
 * A guard whose knobs are silently ignored is a guard an operator believes is in
 * force and is not — the same failure the plugin exists to prevent, one level up.
 * Each refusal here is therefore an arm rather than a nicety.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS, DEFAULT_MAX_REASON_CHARS, resolveConfig } from '../lib/index.js'

describe('the defaults', () => {
  it('normalizes, names the cause after itself, and bounds the reason at 200', () => {
    assert.deepEqual(resolveConfig(), {
      mode: 'normalize',
      reason: undefined,
      maxReasonChars: DEFAULT_MAX_REASON_CHARS,
    })
    assert.deepEqual(resolveConfig({}), resolveConfig())
  })

  it('is frozen, so a mounted configuration cannot be edited later', () => {
    const resolved = resolveConfig()
    assert.equal(Object.isFrozen(resolved), true)
    assert.throws(() => { resolved.mode = 'observe' }, TypeError)
  })

  it('detaches: the mounted object is not the resolved one', () => {
    const mounted = { mode: 'observe' }
    const resolved = resolveConfig(mounted)
    mounted.mode = 'normalize'
    assert.equal(resolved.mode, 'observe')
  })

  it('exposes its defaults as a frozen constant', () => {
    assert.equal(Object.isFrozen(DEFAULTS), true)
    assert.equal(DEFAULTS.mode, 'normalize')
  })
})

describe('the refusals', () => {
  it('refuses an unknown key', () => {
    // A misspelled `mode` that mounts and guards nothing is the failure this
    // refusal exists for.
    assert.throws(() => resolveConfig({ modes: 'observe' }), /unknown key "modes"/u)
    assert.throws(() => resolveConfig({ mode: 'observe', extra: 1 }), /unknown key "extra"/u)
  })

  it('refuses a mode it does not have', () => {
    assert.throws(() => resolveConfig({ mode: 'enforce' }), /mode must be/u)
    assert.throws(() => resolveConfig({ mode: 7 }), /mode must be/u)
  })

  it('refuses a bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '200']) {
      assert.throws(() => resolveConfig({ maxReasonChars: bad }), /positive integer/u, String(bad))
    }
  })

  it('refuses a reason that names nothing', () => {
    // `''` would make the normalized cause say nothing at all, which is the one
    // outcome a *reason* field exists to prevent.
    for (const bad of ['', '   ', 7]) {
      assert.throws(() => resolveConfig({ reason: bad }), /reason must be non-empty text/u, String(bad))
    }
  })

  it('refuses a configuration that is not an object', () => {
    for (const bad of [null, [], 'observe']) {
      assert.throws(() => resolveConfig(bad), /must be an object/u, String(bad))
    }
  })
})

describe('the accepted values', () => {
  it('takes observe as a mode', () => {
    assert.equal(resolveConfig({ mode: 'observe' }).mode, 'observe')
  })

  it('takes a reason override and a bound', () => {
    const resolved = resolveConfig({ reason: 'plugin-bug', maxReasonChars: 12 })
    assert.equal(resolved.reason, 'plugin-bug')
    assert.equal(resolved.maxReasonChars, 12)
  })

  it('accepts an explicit undefined for either optional field', () => {
    // `exactOptionalPropertyTypes` in the source means an explicitly-passed
    // `undefined` is a distinct case from an absent key; both must resolve to the
    // default rather than to a broken value.
    assert.deepEqual(resolveConfig({ mode: undefined, reason: undefined, maxReasonChars: undefined }), resolveConfig())
  })
})
