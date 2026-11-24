# Design

## 1. Status

`0.5.0` is the first public release. The adapter, per-target retry, fallback chain,
persistent breaker, half-open probing, global deadline/attempt cap, session observability,
multi-process state file, background probing and the settings chain editor are implemented
and tested. Tool **execution** retries remain out of scope because the host does not expose
a safe replay hook (see §8).

`targets: []` (or all targets `enabled: false`) leaves the synthetic route registered but
dormant. Invalid configuration fails at load time; it never silently no-ops.

## 2. Goals and non-goals

### Goals

- Configure retry count, initial delay, multiplier, cap and jitter per provider/target.
- One fallback chain, with an **independent** retry budget per target. Switching targets
  restarts backoff from that target's initial delay.
- Independent circuit breaker per target: lock after N consecutive failures, probe once
  when the lock expires, restore only after a real success.
- Retry broken model-generated tool calls (`MALFORMED_RESPONSE`, invalid tool JSON); do not
  retry tool execution by default.
- A settings page that edits the chain and shows the retry schedule.
- Preserve the original failure: when every target fails, throw the last real failure; do
  not fabricate success.

### Non-goals

- Not a replacement for `@deepseek-ai/dsh-llm-retry`, which still owns step-level retries.
- No retry of side-effecting tool execution (bash, file writes, network calls).
- No modification of the DSH core; the integration point is a provider wrapper.
- No infinite retry: a global deadline and attempt cap are mandatory.
- Do not disguise membership expiry or quota exhaustion as transient faults.

## 3. Why a provider wrapper

DSH's `RequestErrorAction` has only `{ kind: 'retry' }`; it cannot switch provider/model.
Changing provider/model inside the `agent/request` waterfall would violate the "route is
fixed when the step is prepared" contract. The only clean plugin-level seam is a provider
adapter: register a synthetic route and resolve the real target inside `stream()`.

## 4. Architecture

```
agent loop / compaction / other callers
        │  provider = "fallback", model = "auto"
        ▼
dsh-llm registry
        ▼
dsh-llm-resilience adapter (wrapper)
        │
        ├─ target 0: primary-gateway/your-model    (retry budget + breaker)
        ├─ target 1: backup-provider/your-model    (retry budget + breaker)
        └─ target 2: local/your-model              (retry budget + breaker)
```

- The wrapper implements `LlmAdapter`; `stream(options)` calls
  `ctx.llm.stream({ ...options, provider, model })` per target.
- The wrapper's own outer `providerRetryPolicy` keeps only the codes needed for "failure
  after content was delivered" (`SERVER` / `TRANSPORT` / `MALFORMED_RESPONSE`, etc.) and a
  small step-replay budget. `FALLBACK_EXHAUSTED` and `ALL_TARGETS_LOCKED` are deliberately
  not in that list, so the whole chain is not replayed blindly.
- Breaker state is keyed by `provider + model`, not by provider alone.
- Configuration lives in the profile patch; runtime state lives in `stateFile` (default
  `$DSH_HOME/storages/llm-resilience/state.json`), written atomically.

## 5. Request flow

```
attempts = planAttempts(targets, breaker, now)
if every target is open/probing: throw ALL_TARGETS_LOCKED (with lockedUntil per target)

for attempt of attempts (chain order):
  if state == open: skip
  if state == half-open:
      if !breaker.beginProbe(key): skip
      probe = minimal chat (maxTokens=1, timeoutMs)
      if probe fails: breaker.probeFailed(key); continue to next target
      # A successful probe does not close the breaker immediately:
      # the real request must succeed before recordSuccess().
  for retry = 0..target.maxRetries:
      stream = ctx.llm.stream({ ...options, provider, model })
      try:
          yield chunks (text/reasoning immediately; tool-call buffered until block-end)
          if finish is success: breaker.recordSuccess(key); return
          failure = finish.failure
      catch error:
          failure = error.failure ?? { code: 'UNKNOWN', message: error.message }
      action = classifyFailure(failure, codeActions)
      if action == 'retry' and retry < target.maxRetries:
          await delay(schedule[retry]); continue
      if action == 'fail':
          do not record a breaker failure; throw the original failure
      # action == 'fallback' or retries exhausted
      breaker.recordFailure(key); break  // next target
throw the last failure
```

### Streaming invariants

- Switch targets inside a request **only before yielding visible content**.
- Text/reasoning deltas are forwarded immediately.
- Tool-call block-start/delta chunks are buffered until `block-end`. A malformed tool call
  (no `block-end`) can therefore be dropped and retried safely.
- After visible content has been delivered, rethrow the original failure and let the host's
  step-level retry replay the step.
- Replay continuation uses `sessionId + request fingerprint` (message count + last
  role/id). On replay, the plan starts at the next target and **rotates**:
  `[...attempts.slice(next), ...attempts.slice(0, next)]`. The hint only changes order; it
  never deletes a target. If the failed target is the chain tail, retry it in place.

## 6. Error classification

Default table (see `lib/policy.js`; override with `codeActions`):

| Error | Action | Why |
|:--|:--|:--|
| `SERVER` + membership/entitlement/quota/billing/credit/plan | fallback | deterministic account state |
| `SERVER` / `TIMEOUT` / `TRANSPORT` / `RATE_LIMIT` / `EMPTY_RESPONSE` / `STREAM_CLOSED` | retry | transient |
| `MALFORMED_RESPONSE` | retry | broken model output; retrying the request is safe |
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | fallback | another provider may work |
| `QUOTA` / `ACCOUNT_QUOTA` | fallback | switch provider/quota |
| `NO_ADAPTER` / `UNKNOWN_MODEL` / `MODEL_NOT_FOUND` | fallback | target unavailable |
| `ABORTED` / `CANCELLED` | fail | caller cancelled |
| `INVALID_REQUEST`/`PI_AI_ERROR`/`UNKNOWN` + an upstream-wrapper marker (`upstream_error`, `upstream_timeout`, `bad_gateway`, `gateway_error`) | fallback | the gateway wrapped its own upstream failure in a 400; the request body is fine and another target succeeds |
| `UNSUPPORTED_OPTION` / `INVALID_REQUEST` / `UNSUPPORTED_CONTENT` | fail | request itself is invalid |
| `IMAGE_OFFLOAD_REQUIRED` | fail (rethrow) | host image-offload recovery |
| `CONTEXT_WINDOW_EXCEEDED` | fail (rethrow) | host compaction recovery |
| unknown | fallback | the last target still throws the original failure |

`IMAGE_OFFLOAD_REQUIRED` and `CONTEXT_WINDOW_EXCEEDED` cannot be overridden: they are part
of DSH's request-level recovery protocol and carry metadata the host needs.

Wrapper detection is deliberately narrowed to the codes pi-ai derives from the status-code
text (`INVALID_REQUEST`, `PI_AI_ERROR`, `UNKNOWN`) and requires one of the wrapper markers
in the message. Rationale: pi-ai maps any message containing `400` to `INVALID_REQUEST`;
gateways routinely use 400 for their own upstream failure (OpenDesign Go: `400
{"code":"upstream_error"}`), and the identical payload succeeds on the next target. Genuine
request errors (invalid tool schema, oversized payload) carry no such marker and still
`fail`. Explicit `codeActions` overrides are applied before this rule and still win.

## 7. Backoff and global budget

```
delay(attempt) = min(initialDelayMs * multiplier^(attempt-1), maxDelayMs)
actualDelay    = min(round(delay * (1 - jitter + 2*jitter*random)), maxDelayMs)
```

- `multiplier` defaults to 2 and accepts values such as 1.5.
- Each target has its own `maxRetries` / `initialDelayMs` / `multiplier` / `maxDelayMs` /
  `jitterRatio`.
- `limits.maxTotalMs` (default 600000) is a deadline: each wait is clipped to the remaining
  time, and the deadline is checked again after the wait.
- `limits.maxAttempts` (default 50) caps the number of upstream requests.
- Exhaustion throws `DEADLINE_EXCEEDED` / `ATTEMPT_LIMIT` with the attempt count, elapsed
  time and last real failure.

Do not give entitlement/quota 500s a large retry budget: they should fall back on the first
failure.

## 8. Tool calls

Two different things must not be conflated:

1. **Broken model output** (`MALFORMED_RESPONSE`, invalid tool JSON, concatenated tool-call
   arguments): this is an LLM request failure, not a tool execution failure. Because tool-call
   chunks are buffered until `block-end`, the host has not seen anything when the stream is
   malformed; the buffer can be dropped and the LLM request retried. Controlled by
   `toolCalls.retryMalformed` (default `true`).
2. **Tool execution failure** (bash non-zero exit, file write failure, network failure): it
   may have side effects and is not retried automatically. In DSH, a bash non-zero exit is a
   successful tool result carrying `[exit code: N]`; the model decides what to do.

Cordis 4.1's `tools/execute` waterfall calls `next()` once; calling it again throws
`next() called multiple times`. The plugin therefore does not ship a `retryExecution` switch.
Automatically replaying a tool body requires a retry hook in the DSH core/executor.

## 9. Circuit breaker and state file

State machine per `provider + model`:

```
closed --(failureThreshold consecutive failures)--> open
open --(now >= lockedUntil)--> half-open
half-open --(beginProbe wins + probe succeeds)--> closed on next real success
half-open --(probe fails)--> open for another lockMs
```

- Open/probing targets are skipped; half-open targets require the single probe slot.
- `enabled: false` targets are filtered before validation and planning; they keep their
  configuration but do not participate in the chain.
- The probe is a minimal chat request (`maxTokens: 1`, short prompt, `timeoutMs`). Do not
  use `/v1/models` as a health check: a gateway can fail `/models` because of entitlement
  while chat is fine, or vice versa.
- `breaker.probe.background: true` makes the current request skip a half-open target and
  probes in the background; the next request uses the result.
- `stateFile` persistence uses `stateFile.lock` + read-merge-write (temp file + rename).
  Merge rules: later lock / more consecutive failures / more lock count wins. A successful
  clear writes a tombstone; older locks cannot be resurrected. Keys this process has never
  seen are not deleted.
- When every target is open/probing, throw `ALL_TARGETS_LOCKED` with each `lockedUntil`.

## 10. Security invariants

- Never switch targets after visible content has been yielded.
- Never auto-retry side-effecting tool execution.
- A target's provider must not equal the wrapper route (no recursion); validated at load.
- Never write API keys or passwords to configuration or logs; `stateFile` stores only
  counters and timestamps.
- Tests use a temporary `DSH_HOME` and temporary ports. Do not restart a live profile as
  part of the test suite.
- Multi-process merge only adds/updates; only a timestamped tombstone can clear a lock.
- When all targets fail, throw the last real failure; never fabricate success or swallow
  errors.
- Before falling back, check the target's capabilities (context window, modalities,
  reasoning effort); `resolveModel` takes the minimum context window and the intersection of
  modalities/effort ranges. Incompatible requests are not silently attempted.

## 11. Tests and verification

Unit tests (`node --test`, 90 cases) cover:

- nominal backoff (2x / 1.5x / cap), jitter bounds, per-target reset;
- classification: entitlement 500 → fallback, transient → retry, invalid → fail, overrides;
- chain validation: empty, duplicate, self-reference, invalid numbers;
- breaker threshold/lock/half-open/probe mutex/success recovery/lock extension/snapshot;
- adapter execution: first success does not touch the second target; transient retries use
  the target's curve; exhausted retries move to the next target and reset backoff;
- fallback on entitlement 500 without spending the retry budget;
- failure after text delivery rethrows the original code and does not switch targets;
- tool-call buffering: malformed calls are retried, complete calls are not duplicated;
- step replay: same fingerprint starts at the next target, rotates to cover the whole chain,
  and retries the tail in place; a different fingerprint discards the hint;
- breaker persistence across processes, including sub-threshold counts, tombstones and
  concurrent writes;
- global deadline/attempt caps, background probing, runtime snapshots and session records;
- settings-client pure functions: field round-trips, unit switching (minutes ↔ ms), retry
  schedule parity with the host, validation and catalogue checks;
- replay envelope wrap/unwrap, including the legacy `dsh-llm-fallback` kind.

End-to-end smoke (isolated `DSH_HOME`, temporary web profile, fake OpenAI-compatible server):

- entitlement 500 on target 1 → fallback to target 2, output normal;
- two transient 500s on target 3 → retry with 100/200 ms backoff, third attempt succeeds;
- all targets fail → `FALLBACK_EXHAUSTED` with the last real failure preserved;
- malformed tool call → buffer dropped and retried, host sees only the successful attempt;
- breaker threshold writes `stateFile`; a new process skips the locked target;
- lock expiry + failed probe → lock again;
- text delivered then transport failure → host replays the step, skips the failed target,
  then succeeds;
- settings card renders in a temporary web profile; add/edit/save/reload round-trips.

## 12. Known limitations and open questions

1. **Wrapper vs core patch.** The wrapper is verified on an isolated DSH. Nested
   `ctx.llm.stream()` passes through the `llm/stream` waterfall again; the session-title
   WeakSet does not mistake the wrapped object for an agent-loop request, and
   `session-checkpoint-policy` flushes once more (harmless). The core is not modified.
2. **Partial output.** Once visible content is delivered, the plugin relies on step replay
   plus target continuation rather than buffering the whole stream. Buffering would remove
   in-request fallback after the first token but delay the first token; it is not the default.
3. **Model catalogue.** The synthetic route exposes one model, `auto`. `resolveModel` takes
   the minimum context window, modality intersection and reasoning effort intersection of
   the chain. The settings page shows the real model for each target.
4. **All targets locked.** `ALL_TARGETS_LOCKED` is thrown; the plugin does not force one
   last request into a locked provider. Whether to allow a "last resort even if locked"
   target is an open question.
5. **Tool execution retry.** Blocked by cordis `next()` single-call semantics; requires a
   core/executor hook.
6. **Replay envelope identity.** The envelope kind changed with the package rename in 0.5.0;
   the unwrapper accepts the legacy kind so in-flight sessions from the private development
   line keep working. Public users start on the new kind.
