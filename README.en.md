# dsh-llm-resilience

**English** | [简体中文](https://github.com/T-splines/dsh-llm-resilience/blob/main/README.md)

**Make a flaky LLM gateway behave like a reliable one — per-target retries, streaming-safe fallback chains and persistent circuit breaking for DeepSeek Harness.**

This plugin was built from a concrete failure mode we hit in daily use. **OpenDesign Go**'s
tool-call stream and API connections were intermittently unstable: a malformed tool-call
stream, a transport drop, or a membership/quota error surfaced as a generic 500 could end
an entire agent step. DSH's built-in `retryPolicy` is provider-level — it can back off on
the same route, but it cannot switch provider/model, and it has no circuit breaker. In our
deployment this plugin moved OpenDesign Go from **barely usable** to **reliably usable**:
safe retries absorb transient faults, a second provider takes over when the gateway is out
of quota or broken, and a persistent breaker stops hammering a dead upstream.

> This is an independent plugin. It is not affiliated with or endorsed by OpenDesign or
> DeepSeek; OpenDesign Go is mentioned only as the deployment that motivated the design.
> The failure pattern is not unique to that service — any gateway that intermittently
> breaks tool-call streams or returns quota errors as generic 500s benefits from the same
> chain.

- [Why this exists](#why-this-exists)
- [What makes it different](#what-makes-it-different)
- [What it registers](#what-it-registers)
- [Install](#install)
- [Configuration](#configuration)
- [Error classification](#error-classification)
- [Streaming, tool calls and step replay](#streaming-tool-calls-and-step-replay)
- [Circuit breaker](#circuit-breaker)
- [Settings page](#settings-page)
- [Limits and honest non-goals](#limits-and-honest-non-goals)
- [Tests](#tests)
- [Compatibility and migration](#compatibility-and-migration)

## Why this exists

DSH's `retryPolicy` already retries at the provider level, but:

- the backoff multiplier is fixed at 2 — you cannot ask for 1.5;
- `agent/request-error` can only retry the **same route**; it cannot switch provider/model;
- there is no circuit breaker: when a provider is down, every step still hits it first;
- `MALFORMED_RESPONSE` (a broken tool-call stream) and a failed tool **execution** need
  different treatment.

This plugin registers a synthetic provider route (default `fallback`, model `auto`) that
internally walks a chain of real provider/model targets:

```
fallback/auto
  ├─ target 0: primary-gateway/your-model       independent retry budget + breaker
  ├─ target 1: backup-provider/your-model       independent retry budget + breaker
  └─ target 2: local/your-model                 independent retry budget + breaker
```

Every target has its own retry budget, backoff curve and breaker. Switching to the next
target resets the backoff instead of inheriting the previous target's already-doubled delay.

## What makes it different

- **Per-target retry budgets.** `maxRetries`, `initialDelayMs`, `multiplier` (including 1.5),
  `maxDelayMs` and `jitterRatio` are independent for each target.
- **Error-aware classification.** Membership/entitlement/quota errors surfaced as `SERVER`
  500 fall back immediately; ordinary 500/timeout/transport errors retry; invalid requests
  fail without trying another target. `codeActions` lets you override the defaults.
- **Streaming-safe tool calls.** Text and reasoning deltas are forwarded immediately.
  Tool-call block-start/delta chunks are buffered until `block-end`, so a malformed tool-call
  stream (no `block-end`) can be retried without the host ever seeing duplicate output.
- **Step-replay continuation.** After content has been delivered, a failure cannot switch
  targets inside the same request. The plugin remembers `sessionId + request fingerprint`;
  when the host replays the step it starts at the next target, and the plan **rotates** to
  cover the whole chain instead of truncating it. If the failure was the chain tail, it is
  retried in place — a retryable failure is never rewritten into a terminal
  `FALLBACK_EXHAUSTED`.
- **Persistent circuit breaker, per provider + model.** Consecutive failures lock a target
  for a configurable window; the lock expires into a half-open probe (foreground or
  background). State is written atomically to `stateFile` and merged across processes with
  a lock + tombstones, so a restart does not forget a partially accumulated failure count.
- **Global budget.** `limits.maxTotalMs` (default 10 minutes) and `limits.maxAttempts`
  (default 50) are enforced across targets and retries; backoff waits count toward the
  deadline. No combination of targets × retries can hang a step for an unbounded time.
- **Request-level recovery codes pass through.** `IMAGE_OFFLOAD_REQUIRED` (with
  `offloadImages`) and `CONTEXT_WINDOW_EXCEEDED` are re-thrown unchanged so the host's image
  offload / compaction layers can recover first.
- **Settings page.** Edit the chain, reorder targets, see each retry schedule, and watch live
  breaker state (`closed / open / half-open / probing`) next to version and uninstall.
- **Tested.** 90 `node --test` cases plus isolated DSH end-to-end smoke runs with a fake
  OpenAI-compatible server (see [DESIGN.md](DESIGN.md)).

## What it registers

| entry | value |
|:--|:--|
| synthetic route | `fallback` (configurable) |
| synthetic model | `auto` |
| profile entry id | `llm-fallback` (kept stable for settings compatibility) |
| package name | `@magic6/dsh-llm-resilience` |
| default state file | `$DSH_HOME/storages/llm-resilience/state.json` |

`targets: []` (or every target `enabled: false`) leaves the route registered but dormant:
you can build the chain in the settings page first, then enable it.

## Install

Requirements: DSH `0.2.2-rc.x`, Node.js 20+.

### From npm

```bash
dsh plugin --profile web add @magic6/dsh-llm-resilience
```

### From source

```bash
git clone https://github.com/T-splines/dsh-llm-resilience.git
cd dsh-llm-resilience
dsh plugin --profile web add "$PWD"
```

The package is a bundle (`dsh.bundle.patch`), so the `llm-fallback` entry is already mounted
by the bundle. **Override that entry** — do not `insert` a second one. In
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, replacing the whole `config`:

```yaml
- id: llm-fallback
  name: '@magic6/dsh-llm-resilience'
  config:
    enabled: true
    route: fallback
    targets:
      - enabled: true
        provider: primary-gateway
        model: your-model
        maxRetries: 5
        initialDelayMs: 1500
        multiplier: 2
        maxDelayMs: 20000
        jitterRatio: 0.3
      - enabled: true
        provider: backup-provider
        model: your-backup-model
        maxRetries: 3
        initialDelayMs: 1000
    breaker:
      failureThreshold: 5
      lockMs: 3600000
      probe:
        enabled: true
        background: false
        timeoutMs: 10000
        maxTokens: 1
        prompt: 'ping'
      stateFile: '$DSH_HOME/storages/llm-resilience/state.json'
    limits:
      maxTotalMs: 600000
      maxAttempts: 50
    toolCalls:
      retryMalformed: true
```

Replace `primary-gateway` / `backup-provider` with real provider ids from your DSH model
catalog (the settings page shows them as read-only dropdowns). A target whose provider does
not exist fails with `NO_ADAPTER` and the chain moves on; it does not silently pretend the
target served.

Then point the agent's default model at the synthetic route:

```yaml
- id: agent-default-model
  config:
    provider: fallback
    model: auto
```

Verify composition without starting an agent (`web` is the common profile name; use yours):

```bash
dsh --profile web --dump-config | grep -A8 'id: llm-fallback'
```

> When overriding an existing `llm-fallback` entry with `--patch`, write the **whole**
> `targets` array. DSH's config merge fills omitted array fields with an empty default, so
> overriding only `breaker` would clear the chain.

**Do not give entitlement/quota errors 10 retries.** They are deterministic provider state;
retrying the same target only wastes the budget. They should fall back on the first failure.

## Configuration

| field | meaning |
|:--|:--|
| `enabled` | master switch; the route still exists when disabled, but rejects requests |
| `route` | synthetic provider name (default `fallback`); must not appear in `targets` |
| `targets[]` | ordered `{ provider, model, enabled, label, maxRetries, initialDelayMs, multiplier, maxDelayMs, jitterRatio }` |
| `breaker` | `failureThreshold`, `lockMs`, probe settings (`enabled`, `background`, `timeoutMs`, `maxTokens`, `prompt`), `stateFile` |
| `limits` | `maxTotalMs`, `maxAttempts`; `0` disables that dimension |
| `toolCalls.retryMalformed` | retry a broken model-generated tool call (default `true`); tool **execution** retries are not supported |
| `codeActions` | override the default action per stable error code (`retry` / `fallback` / `fail`) |

## Error classification

| error | action | why |
|:--|:--|:--|
| `SERVER` + membership/entitlement/quota/billing/credit/plan | fallback | deterministic account state; retrying is useless |
| `SERVER` / `TIMEOUT` / `TRANSPORT` / `RATE_LIMIT` / `EMPTY_RESPONSE` / `STREAM_CLOSED` | retry | transient |
| `MALFORMED_RESPONSE` | retry | broken model output; safe to retry the whole LLM request |
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | fallback | another provider may work |
| `QUOTA` / `ACCOUNT_QUOTA` | fallback | switch provider/quota |
| `NO_ADAPTER` / `UNKNOWN_MODEL` / `MODEL_NOT_FOUND` | fallback | target unavailable |
| `ABORTED` / `CANCELLED` | fail | the caller cancelled |
| `UNSUPPORTED_OPTION` / `INVALID_REQUEST` / `UNSUPPORTED_CONTENT` | fail | the request itself is wrong; another target will not fix it |
| `IMAGE_OFFLOAD_REQUIRED` | fail (re-thrown) | host image-offload recovery must see it |
| `CONTEXT_WINDOW_EXCEEDED` | fail (re-thrown) | host compaction recovery must see it |
| unknown code | fallback | the last target still throws the original failure; nothing is swallowed |

`IMAGE_OFFLOAD_REQUIRED` and `CONTEXT_WINDOW_EXCEEDED` cannot be overridden: they are part
of DSH's request-level recovery protocol, and the host's listeners depend on the original
code and metadata.

## Streaming, tool calls and step replay

- Only switch targets **before** yielding anything visible to the caller.
- Text/reasoning deltas are forwarded immediately.
- Tool-call block-start/delta chunks are buffered until `block-end`; a malformed tool call
  (no `block-end`) can be dropped and retried safely.
- After visible content has been delivered, a failure is returned to the host so
  `dsh-llm-retry` can replay the whole step. The plugin records a fingerprint and the
  target it reached; on replay it starts at the next target. The plan **rotates** rather
  than truncating, so a target before the failure point is not lost. If the failure was the
  chain tail, it retries that target in place.
- The replay envelope written by the synthetic route is unwrapped into the real target's
  provider/model before the request reaches the upstream adapter, preserving signatures and
  ids. Envelopes written by the pre-rename `dsh-llm-fallback` package are still accepted.

## Circuit breaker

```
closed --(failureThreshold consecutive failures)--> open
open --(lock expires)--> half-open
half-open --(probe succeeds)--> closed on the next real success
half-open --(probe fails)--> open for another lock window
```

- State is keyed by `provider + model`, not by provider alone.
- `stateFile` is written atomically with a lock + read-merge-write. Concurrent processes
  keep the later/more-failed entry; a successful clear writes a tombstone so an older lock
  cannot be resurrected.
- Unreached failure counts are persisted too (`updatedAt` is the merge timeline), so a
  restart does not reset the count below the threshold.
- When every target is open/probing, the plugin throws `ALL_TARGETS_LOCKED` with each
  target's `lockedUntil` — it does not force one last request into a locked provider.

## Settings page

Plugins → Installed → `@magic6/dsh-llm-resilience` → **Model fallback chain**:

- per-target rows: enabled, provider, model (read-only dropdowns from the session model
  catalog), label, retry parameters, move up/down, delete, add;
- retry-plan tooltip: one line per retry, with the jitter range when `jitter > 0`;
- breaker and budget fields;
- live runtime state polled from the host (`closed / open / half-open / probing`, remaining
  lock time, consecutive failures and lock count);
- non-loopback browsers get the host's memory-state view and the card says so instead of
  rendering plugin defaults as if they were the deployed policy.

## Limits and honest non-goals

- **Tool execution is not retried.** Cordis 4.1's `tools/execute` waterfall calls `next()`
  once; calling it again throws `next() called multiple times`. Automatically replaying a
  tool body needs a retry hook in the DSH core/executor. The plugin does not ship a switch
  that silently does nothing. Retrying a malformed **model-generated** tool call is safe and
  supported.
- **No infinite retries.** The global deadline and attempt cap are required; `0` disables a
  dimension but is not recommended for production.
- **Does not replace `@deepseek-ai/dsh-llm-retry`.** That package still owns step-level
  retries; this plugin owns provider selection and request-level resilience.
- **No streaming buffer for late fallback.** Once visible content is delivered, switching
  targets would duplicate output; the plugin hands the step back to the host instead.

## Tests

```bash
npm test
```

90 cases cover backoff/jitter, error classification, chain validation, adapter execution,
streaming safety, step-replay rotation, breaker persistence and multi-process merging,
global budgets, background probing, settings-client pure functions and the replay envelope
(including the legacy package name). End-to-end smoke runs on an isolated `DSH_HOME` with a
fake OpenAI-compatible server are described in [DESIGN.md](DESIGN.md).

## Compatibility and migration

- DSH `0.2.2-rc.x` (`engines.dsh` is `>=0.2.2-0 <0.3.0-0`), Node.js 20+.
- **Renamed from `dsh-llm-fallback` in 0.5.0.** The profile entry id remains `llm-fallback`,
  so settings and existing patches keep working; update the `name:` field to
  `@magic6/dsh-llm-resilience`.
- The default breaker state file moved to
  `$DSH_HOME/storages/llm-resilience/state.json`. Set `stateFile` explicitly if you want to
  keep using an older breaker file.
- Replay envelopes from the old package name still unwrap (`dsh-llm-fallback` is accepted as
  a legacy kind).

## License

MIT. See [LICENSE](LICENSE).
