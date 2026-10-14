/**
 * The shapes this plugin's configuration and its guard report take.
 *
 * @module @argszero/dsh-cancel-cause-guard/types
 */

/**
 * What the guard does with a cause that is not a member of the closed union.
 *
 * - `normalize` — the default, and the reason the plugin exists: the value is
 *   carried as a `{ kind: 'hook', reason }` cause, the turn ends normally, and
 *   the log records which value was rewritten.
 * - `observe` — the value is passed through unchanged, so the turn fails exactly
 *   as it would without the plugin, and the log records what was seen. This is
 *   the arm for an operator who wants to find a producer before protecting the
 *   session from it: the plugin reports, and nothing else changes.
 */
export type GuardMode = 'normalize' | 'observe'

/** The plugin configuration as mounted; every field is optional. */
export interface Config {
  /** What to do with an out-of-union cause. Defaults to `normalize`. */
  readonly mode?: GuardMode | undefined
  /**
   * The reason text to record for every cause the guard rewrites, in place of
   * the value's own name. Defaults to the name the value carried (`'thinking-loop'`
   * for `{ kind: 'thinking-loop' }`, a JSON rendering otherwise).
   */
  readonly reason?: string | undefined
  /** Bound on the reason text the guard mints. Defaults to 200. */
  readonly maxReasonChars?: number | undefined
}

/** The configuration after defaults, validation and detaching. */
export interface ResolvedConfig {
  readonly mode: GuardMode
  readonly reason: string | undefined
  readonly maxReasonChars: number
}

/** What {@link guardCancel} found when it reached an agent. */
export type GuardOutcome =
  /** The instance's own `cancel` now normalizes out-of-union causes. */
  | 'patched'
  /** Somebody's guard — this plugin's, mounted twice — is already in place. */
  | 'already-guarded'
  /** The instance carries no callable `cancel`; there is nothing to shadow. */
  | 'no-cancel'
  /** The instance refuses an own property (`cancel` is non-writable, or the object is sealed). */
  | 'not-writable'

/** One cause the guard rewrote, as it was reported. */
export interface NormalizedCause {
  /** The value the caller passed. */
  readonly original: unknown
  /** The union member it was carried as. */
  readonly normalized: { readonly kind: 'hook'; readonly reason: string }
  /** How the original was described for the log. */
  readonly described: string
}

/** The handle {@link guardCancel} returns: how it went, and an undo. */
export interface GuardHandle {
  /** What happened when the guard was installed. */
  readonly outcome: GuardOutcome
  /** Restore the instance's own `cancel`, when this guard installed one. */
  readonly restore: () => void
}
