# @argszero/dsh-cancel-cause-guard

A prevention guard for the one `turn/end` row that makes a whole conversation view
unreadable.

The harness ships an `Agent.cancel(cause)` whose argument is a **closed** union —
`{ kind: 'user' }`, `{ kind: 'parent' }`, `{ kind: 'hook', reason }`,
`{ kind: 'disposed' }` — and that union is enforced by TypeScript alone. Nothing on
the write path refuses a value outside it, and one such value does not merely log
something odd: it ends the session's usefulness. This plugin normalizes the
out-of-union value at the last moment the harness still lets a plugin see it, so the
turn ends with a readable reason instead of `null`.

## The defect

`ReactLoopAgent.cancel` passes its argument straight to `AbortController.abort()`, so
the cause becomes `signal.reason`. The turn's `catch` reads it back through
`abortedCancelCause` (`dsh-agent-loop/src/agent.ts:80`):

```ts
const cause = signal.reason as AgentCancelCause
switch (cause.kind) {
  case 'user': case 'parent': case 'disposed': return { kind: cause.kind }
  case 'hook': return { kind: 'hook', reason: cause.reason }
  default: return assertNever(cause)
}
```

That function is called **inside the `catch`**. A value outside the union therefore
throws before the catch body assigns `turnEnds`, which is still at its `null`
initializer, and the `finally` appends unconditionally:

```ts
let turnEnds: TurnEndReason | null = null                 // agent.ts:310
...
} finally {
  this.session.append('turn/end', { turn, reason: turnEnds! })   // agent.ts:385
}
```

The non-null assertion on that line is what makes it compile, and the row lands as
`{"type":"turn/end","data":{"turn":N,"reason":null}}`. Nothing rejects it on the way:
the append-time validator inspects surface message slots, `request/header` and
`tool/result`, so `reason` is a TypeScript-only invariant. Every reader that
dereferences it then throws — the chat client does `location.turn.end?.data.reason.kind`
while rendering — and one such row blanks the entire conversation area, for every
session, including newly created ones.

Reported three times: discussions **#8832**, **#9156** and **#9646**.

### The version boundary

A harness older than `0.1.7` had no such function. The turn's `catch` wrote
`{ kind: 'aborted', reason: signal.reason }` verbatim, so the same abuse produced a
malformed-but-readable row rather than a `null` one. From `0.1.7-rc.2` on, the same
abuse is fatal — which is why this is a **guard** and not a report: the shape of the
failure changed under callers that had not changed at all.

## What it does

It listens to `agent/created` — the serial, awaited lifecycle edge that hands over the
**live agent instance** (`dsh-agent/src/index.ts:550`) — and shadows that instance's
`cancel` with a wrapper that normalizes anything outside the union into
`{ kind: 'hook', reason: <the value's own name> }` before the loop ever sees it.

- **`hook` is the right member, not a convenient one.** It is the member the union
  reserves for plugins: a plugin did cancel the turn, and the reason names which one.
- **One property write covers every instance-level caller.** `ReactLoopAgent.cancel`
  is a prototype method, so an **own** property of that name shadows it for the loop's
  own `agent.cancel({ kind: 'user' })`, the chat client's stop button, and any
  third-party plugin alike.
- **A valid cause is forwarded by reference.** The object the loop reads back out of
  the signal is the object the caller passed; nothing is copied and nothing is
  reported.
- **A cancellation is never refused.** The wrapper normalizes, forwards and reports,
  in that order, and touches nothing but the cause — a plugin that stopped a stop
  would be worse than the defect.
- **Two shapes are covered, and only one of them looks like a mistake.** An object
  whose `kind` is missing or unknown (`{ kind: 'thinking-loop' }`), and a value that
  is not an object at all — most often `undefined`, from a caller whose own
  declaration made the argument optional, where `cause.kind` throws one line earlier.
- **The wrapper binds the original to the agent it came from**, so a caller holding a
  detached `const cancel = agent.cancel` still reaches the method with the receiver
  its body requires.

Every rewrite is logged with the offending value rendered as JSON, so the producer can
be found and fixed rather than tolerated.

## Install

```sh
npm install @argszero/dsh-cancel-cause-guard
```

Then mount it from your profile's bundle patch (`dsh.bundle.patch`):

```yaml
- insert:
    - id: cancel-cause-guard
      name: '@argszero/dsh-cancel-cause-guard'
```

Or, if you compose `cordis.yml` by hand:

```yaml
- set:
    - id: cancel-cause-guard
      name: '@argszero/dsh-cancel-cause-guard'
      config:
        mode: normalize
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mode` | `'normalize'` | `normalize` rewrites an out-of-union cause to `{ kind: 'hook', reason }`; `observe` passes the caller's value through untouched and only records the producer. |
| `reason` | absent | Reason text to record in place of the value's own name. Absent names the cause after the value that produced it — the only handle on whoever produced it. |
| `maxReasonChars` | `200` | Bound on the minted reason, in characters. |

A configuration the plugin cannot honour is refused **at mount** rather than quietly
replaced: an unknown key, a mode this plugin does not have, a `reason` that would name
nothing, or a bound that is not a positive integer. A misspelled `mode` that mounts and
guards nothing is how an operator believes a guard is in force when it is not.

## Diagnostics

One warning per rewritten (or, in `observe` mode, merely reported) cause:

```
cancel-cause-guard: session <id>: a caller passed "thinking-loop" as a cancellation
cause, which is not a member of AgentCancelCause; the turn was recorded as
{ "kind": "aborted", "reason": { "kind": "hook", "reason": "thinking-loop" } }.
Which plugin passes it is the value itself: the reason carries its own name.
```

`observe` mode says the value was passed through instead, so the operator sees the
real failure and the log does not claim a repair.

Two refusals are warned about at the moment they matter, because a guard that is
silently absent is the thing an operator cannot see:

- an agent that carries no `cancel` method at all;
- an agent that refuses an own `cancel` property (a sealed or non-writable instance),
  where the install is confirmed by **reading the property back**, not by the absence
  of a throw.

## What it is not

- **It cannot repair a session that already carries a `null` row.** Those rows are on
  disk and this plugin reads no history. Mounting it bounds the defect from that point
  on; the sessions that already have one stay unreadable until the row is removed.
- **It does not cover a caller that reaches the class rather than the instance** —
  `ReactLoopAgent.prototype.cancel.call(agent, …)`, or a second copy of the loop.
  Nothing observable hands that path over, which is why `mode: 'observe'` exists: an
  operator who wants to see the failure happen may mount this plugin as a reporter and
  still get the producer named in the log.
- **It does not patch the union away.** Values that are already members are neither
  copied, rewritten, nor reported.
- **It calls no model and needs no service.** `inject` is empty: the whole seam is the
  agent instance the lifecycle edge delivers.

## Evidence

- `test/lifecycle.spec.mjs` — the plugin mounted through a real Cordis context, against
  the real `AgentRegistry` and the real `agent/created` dispatch: the guard is installed
  by the time the announce dispatch settles, it does not touch an agent published before
  the mount, unmounting restores the instance (both when the fiber disposes and when the
  agent does), and `world({ mounted: false })` is the control arm for each.
- `test/guard.spec.mjs` — the mechanism: an own property over a prototype method, the
  options handed through untouched, the original bound to its agent, the mark a second
  mount recognises, the undo that reveals the prototype method again rather than copying
  it in, and every refusal.
- `test/cause.spec.mjs` — the pure half: what each shape becomes, what it is called, the
  bound, and the values that must never throw inside `cancel`.
- `test/config.spec.mjs` — the defaults, detaching, and the five refusals.
- `scripts/witness-cancel-cause.mjs` — the consequence, proved against the **published**
  `@deepseek-ai/dsh-agent-loop` sources rather than a stand-in: it extracts
  `abortedCancelCause` and `assertNever` from the shipped tarball, shows a bare-string
  cause throwing `unreachable variant: "thinking-loop"` unguarded and returning
  `{ kind: 'hook', reason: 'thinking-loop' }` guarded, and records the `0.1.6-alpha.2`
  boundary where no such function exists. Run it with
  `npm run witness:cancel-cause`.
- `npm run test:inject` — mutates the source, rebuilds, and requires each mutation to be
  caught by the suite. An arm whose mutation leaves the suite green proves nothing about
  the test that was supposed to hold the line, and is reported as `SILENT`.
- `npm run probe:lines` — runs the suite once per released line, each with every harness
  package pinned to that line. That measurement is where the supported-lines list below
  comes from.

## Supported lines

The suite is measured green against each of these, with `peerDependencies` restricted to
the same three:

| Harness line | Cordis series |
|---|---|
| `0.1.7-rc.2` | `4.0.4` |
| `0.2.0-rc.2` | `4.0.4` |
| `0.2.1-alpha.2` | `~4.0.5-alpha.1` |

Earlier generations are **not** covered and are not claimed: `0.1.6-alpha.2` and below
have no `abortedCancelCause`, so there is nothing for this plugin to prevent there.

## License

MIT.
