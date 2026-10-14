# @argszero/dsh-cancel-cause-guard

A prevention guard for the one `turn/end` row that makes a whole conversation view
unreadable.

The harness ships an `Agent.cancel(cause)` whose argument is a **closed** union —
`{ kind: 'user' }`, `{ kind: 'parent' }`, `{ kind: 'hook', reason }`,
`{ kind: 'disposed' }` — and that union is enforced by TypeScript alone. Nothing on
the write path refuses a value outside it, and one such value does not merely log
something odd: it ends the session's usefulness. This plugin normalizes the
out-of-union value at the last moment the harness still lets a plugin see it, and
backstops the session's own `append` so that even a cancellation it never gets to
see cannot commit an unreadable row.

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
let turnEnds: TurnEndReason | null = null                 // agent.ts:312
...
} finally {
  this.session.append('turn/end', { turn, reason: turnEnds! })   // agent.ts:387
}
```

The non-null assertion on that line is what makes it compile, and the row lands as
`{"type":"turn/end","data":{"turn":N,"reason":null}}`. Nothing rejects it on the way:
the append-time validator inspects surface message slots, `request/header` and
`tool/result`, so `reason` is a TypeScript-only invariant. Every reader that
dereferences it then throws — the chat client does `location.turn.end?.data.reason.kind`
while rendering — and one such row blanks the entire conversation area, for every
session, including newly created ones.

Reported four times: discussions **#8832**, **#9156**, **#9646** and **#9699**.

### The version boundary

A harness older than `0.1.7` had no such function. The turn's `catch` wrote
`{ kind: 'aborted', reason: signal.reason }` verbatim, so the same abuse produced a
malformed-but-readable row rather than a `null` one. From `0.1.7-rc.2` on, the same
abuse is fatal — which is why this is a **guard** and not a report: the shape of the
failure changed under callers that had not changed at all.

### The two callers an entry guard cannot reach

`ReactLoopAgent.cancel` is the only aborter of the signals the loop owns — the
function's own comment says so — so shadowing that method covers every caller that
goes through the agent **instance**. Two do not:

- a caller that reaches the **class** rather than the instance
  (`ReactLoopAgent.prototype.cancel.call(agent, cause)`, or a second copy of the
  loop in the same process), which no observable hook hands over; and
- an instance that **refuses** the own `cancel` property, where the entry guard
  reports that it is not in force and nothing protects the session at all.

Both end with the same unreadable row. That is what the second half of this plugin
is for.

## What it does

### 1. Normalize the cause at the entry

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

### 2. Backstop the row at the write

The same lifecycle edge hands over the **live session**, and `Session.append` is a
prototype method of it — so one own-property write shadows the append path for every
writer, the loop's own rows included. Only one event type is inspected.

- **The row it writes is the row the loop meant to write.** When a `turn/end` arrives
  whose reason no reader can dereference, the backstop commits
  `{ kind: 'aborted', reason: { kind: 'hook', reason: <text> } }` instead: the turn
  *was* interrupted by a cancellation, `aborted` is a member every reader knows, and
  `hook` is the member that says the cancellation came from outside the union.
- **It does not invent a variant.** `TurnEndReasonMap` is merge-extensible, so a new
  `kind` would be a value the readers have never seen — trading a loud failure for a
  silent one.
- **The test is dereferenceability, not membership.** A reason is left alone when it
  is a non-null object carrying a non-empty string `kind`, because a plugin may
  legitimately extend the map with a variant this plugin knows nothing about. What is
  refused is the shape no reader can read at all: `null`, absent, or not an object.
- **It never edits the caller's payload.** The replacement is a new object; the one
  the loop handed over is left as it was.
- **Every other event is forwarded untouched**, whatever it carries, and a
  `turn/end` whose payload is not an object is reported rather than rebuilt — the
  event map promises `{ turn, reason }`, and writing the missing half would be
  inventing a durable row.
- **It is switchable off** with `backstop: false`, for an operator who wants the
  append path to be exactly the harness's.

Every cause rewrite and every repaired row is logged, with the offending value
rendered as JSON, so the producer can be found and fixed rather than tolerated.

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
| `mode` | `'normalize'` | `normalize` rewrites an out-of-union cause to `{ kind: 'hook', reason }` and repairs an unreadable `turn/end` reason; `observe` passes both through untouched and only records what arrived. |
| `reason` | absent | Reason text to record in place of the value's own name. Absent names the cause after the value that produced it — the only handle on whoever produced it — and names a repaired row after what it is: a cancellation the entry guard never saw. |
| `maxReasonChars` | `200` | Bound on the minted reason, in characters. |
| `backstop` | `true` | Whether the durable backstop is installed as well. `false` leaves the session's own `append` untouched. |

A configuration the plugin cannot honour is refused **at mount** rather than quietly
replaced: an unknown key, a mode this plugin does not have, a `reason` that would name
nothing, a bound that is not a positive integer, or a `backstop` that is not a boolean.
A misspelled `mode` that mounts and guards nothing is how an operator believes a guard
is in force when it is not.

## Diagnostics

One warning per rewritten (or, in `observe` mode, merely reported) cause:

```
cancel-cause-guard: session <id>: a caller passed "thinking-loop" as a cancellation
cause, which is not a member of AgentCancelCause; the turn was recorded as
{ "kind": "aborted", "reason": { "kind": "hook", "reason": "thinking-loop" } }.
Which plugin passes it is the value itself: the reason carries its own name.
```

One warning per repaired `turn/end` row, in a deliberately different sentence — a row
this arm repaired is a cancellation the **entry guard never saw**, and an operator has
to be able to tell the two apart:

```
cancel-cause-guard: session <id>: a turn/end row for turn 4 reached the log with a
reason no reader can dereference (null); it was recorded as { "kind": "aborted",
"reason": { "kind": "hook", "reason": "a cancellation cause the entry guard never
saw" } }. The cancellation never passed the entry guard, so its cause is not in this
record: a caller reached the cancel method through the class rather than through the
instance, a second copy of the loop aborted a signal of its own, or the instance
refused the guard.
```

`observe` mode says the value (or the row) was passed through instead, so the operator
sees the real failure and the log does not claim a repair.

Four refusals are warned about at the moment they matter, because a guard that is
silently absent is the thing an operator cannot see:

- an agent that carries no `cancel` method at all;
- an agent that refuses an own `cancel` property (a sealed or non-writable instance),
  where the install is confirmed by **reading the property back**, not by the absence
  of a throw — the durable backstop covers this agent's session all the same;
- a session that carries no `append` method;
- a session that refuses an own `append` property.

## What it is not

- **It cannot repair a session that already carries a `null` row.** Those rows are on
  disk and this plugin reads no history. Mounting it bounds the defect from that point
  on; the sessions that already have one stay unreadable until the row is removed.
- **It does not patch the unions away.** Causes that are already members are neither
  copied, rewritten, nor reported, and a `turn/end` reason a reader can dereference is
  forwarded as it is, whatever variant it names.
- **It calls no model and needs no service.** `inject` is empty: the whole seam is the
  agent instance and the session the lifecycle edge delivers.
- **It writes no history.** Both arms only affect rows that are about to be committed;
  a row already in the log is never read, rewritten or deleted.

## Evidence

- `test/lifecycle.spec.mjs` — the plugin mounted through a real Cordis context, against
  the real `AgentRegistry` and the real `agent/created` dispatch, on a real
  `@deepseek-ai/dsh-session` `Session`: the guard and the backstop are installed by the
  time the announce dispatch settles, neither touches an agent published before the
  mount, unmounting restores both properties (when the fiber disposes and when the
  agent does), a sealed instance is still backstopped at the write, and
  `world({ mounted: false })` is the control arm for each — including the arm that
  writes the `{"turn":1,"reason":null}` row **unmounted** and reads it back out of the
  log, which is the defect reproduced against the shipped class rather than described.
- `test/backstop.spec.mjs` — the second mechanism: an own property over a prototype
  method, the row it writes for each unreadable shape, what it leaves alone (a readable
  reason by reference, a plugin's own variant, every other event type), the payload it
  does not mutate, and every refusal.
- `test/guard.spec.mjs` — the first mechanism: an own property over a prototype method,
  the options handed through untouched, the original bound to its agent, the mark a
  second mount recognises, the undo that reveals the prototype method again rather than
  copying it in, and every refusal.
- `test/cause.spec.mjs` — the pure half: what each shape becomes, what it is called, the
  bound, and the values that must never throw inside `cancel`.
- `test/config.spec.mjs` — the defaults, detaching, and the refusals.
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
  comes from, and it covers the backstop's seam too: the suite's own session is the
  line's published `Session`, and the unmounted control arm asserts that this line's
  write path accepts `reason: null`.

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
