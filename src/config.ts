/**
 * Configuration resolution for the cancellation-cause guard.
 *
 * The surface is deliberately three fields. A guard that rewrites a value on a
 * path as hot as cancellation has to be readable in one sitting, and every knob
 * it does not have is a way for an operator to be surprised by what it did.
 *
 * An unknown key is refused rather than ignored: a misspelled `mode` that mounts
 * and guards nothing is how an operator believes a guard is in force when it is
 * not — the same refusal `dsh-tool-output-budget` makes, for the same reason.
 *
 * @module @argszero/dsh-cancel-cause-guard/config
 */

import { DEFAULT_MAX_REASON_CHARS, UNSPECIFIED_REASON } from './cause.ts'
import type { Config, GuardMode, ResolvedConfig } from './types.ts'

/** Defaults for a guard whose only job is to keep a session readable. */
export const DEFAULTS: ResolvedConfig = Object.freeze({
  mode: 'normalize',
  reason: undefined,
  maxReasonChars: DEFAULT_MAX_REASON_CHARS,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set(['mode', 'reason', 'maxReasonChars'])

const MODES: ReadonlySet<string> = new Set<GuardMode>(['normalize', 'observe'])

/**
 * Resolve, validate and detach the guard configuration.
 * @param config - raw plugin configuration, possibly empty.
 * @returns a detached, frozen configuration.
 * @throws {Error} when a key is unknown, a mode is not one this plugin has, a
 *   reason is not non-empty text, or the bound is not a positive integer.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('cancel-cause-guard config: must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `cancel-cause-guard config: unknown key "${key}" `
        + '(allowed: mode, reason, maxReasonChars)',
      )
    }
  }

  const mode = config.mode ?? DEFAULTS.mode
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new Error('cancel-cause-guard config: mode must be "normalize" or "observe"')
  }

  const maxReasonChars = config.maxReasonChars ?? DEFAULTS.maxReasonChars
  if (!Number.isSafeInteger(maxReasonChars) || maxReasonChars < 1) {
    throw new Error('cancel-cause-guard config: maxReasonChars must be a positive integer')
  }

  // A reason override of `''` would make the normalized cause say nothing at
  // all, which is the one outcome a *reason* field exists to prevent. `undefined`
  // is the "name it after the value the caller passed" default; an empty string
  // is a mistake, and is reported as one.
  const reason = config.reason
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0)) {
    throw new Error(
      `cancel-cause-guard config: reason must be non-empty text, or absent to name the cause `
      + `after the value that produced it (the default resolves to "${UNSPECIFIED_REASON}" only `
      + 'for a cause that carried no name)',
    )
  }

  return Object.freeze({ mode, reason, maxReasonChars })
}
