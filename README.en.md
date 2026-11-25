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
- [Reasoning effort](#reasoning-effort)
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
- **Reasoning effort never makes a model unusable.** The synthetic model advertises the
  full level set; a session's `max` is mapped to each target's nearest declared level, and
  a target with no thinking metadata simply receives no effort parameter (its own default).
- **Tested.** 117 `node --test` cases plus 12 isolated DSH end-to-end scenarios against a
  fake OpenAI-compatible server (see [DESIGN.md](DESIGN.md)).

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

Requirements: DSH `0.2.1-rc.x` / `0.2.2-rc.x`, Node.js 20+.

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
| `targets[]` | ordered `{ provider, model, enabled, label, reasoningEffort, maxRetries, initialDelayMs, multiplier, maxDelayMs, jitterRatio }` |
| `breaker` | `failureThreshold`, `lockMs`, probe settings (`enabled`, `background`, `timeoutMs`, `maxTokens`, `prompt`), `stateFile` |
| `limits` | `maxTotalMs`, `maxAttempts`; `0` disables that dimension |
| `toolCalls.retryMalformed` | retry a broken model-generated tool call (default `true`); tool **execution** retries are not supported |
| `codeActions` | override the default action per stable error code (`retry` / `fallback` / `fail`) |

A target's `reasoningEffort` defaults to `auto` (follow the session/host request). Setting
it to `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` (or a provider-specific
name) fixes that target to the value; an unsupported value is still mapped by the rules
below.

## Reasoning effort

The host validates `reasoningEffort` against the synthetic `fallback/auto` model **before**
a request reaches the adapter. If that model only declared the intersection of target
capabilities, one manually added model without thinking metadata would reject `max` before
the chain runs — exactly what happened in 0.5.10 and earlier. The synthetic model now always
advertises the full standard level set; the real choice is made per target at dispatch:

| standard level | value |
|:--|--:|
| `off` | 0 |
| `minimal` | 10 |
| `low` | 25 |
| `medium` | 50 |
| `high` | 75 |
| `xhigh` | 90 |
| `max` | 100 |

- Common aliases (`none`, `extra-high`, `maximum`, …) share the same scale; numeric strings
  from `0` to `100` are accepted too.
- **Nearest mapping:** pick the closest level the target declares; on a tie choose the
  higher one (asking for `max` never silently becomes `low`).
- **Unknown name:** fall back to the target's highest level; only when it has no rankable
  levels use `defaultEffort`, then its first level.
- **No thinking metadata:** omit `reasoningEffort` and use the target default. A model that
  works when called directly remains usable inside the chain; a one-time warning points at
  `reasoningEfforts` (or `modelOverrides.reasoningEfforts`) when the model actually supports
  thinking but the provider profile does not declare it.
- **Runtime backstop:** if the upstream still rejects the level, the adapter reads the
  supported levels from its error message, retries the nearest one, then retries once with
  the parameter omitted. Only after that does it count as a target failure and fall back.
- Mapping and omission are recorded in the session as `plugin:llm-fallback`
  (`kind: "effort"`), so "why did this target receive a different level?" is answerable.

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
  catalog), reasoning effort, label, retry parameters, move up/down, delete, add; the
  effort dropdown lists declared levels first, then standard levels, with `auto` meaning
  "follow the session";
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

## Tested platforms

The suite is run, and passes, on every platform listed here — this is measured, not
assumed:

| Platform | Version | Result | How |
|:--|:--|:--|:--|
| macOS | 26.6.2 arm64 | ✅ 99/99 | full `npm test` on the machine |
| Windows | 11 22631 x64 | ✅ 99/99 | full `npm test` on real hardware |
| Linux | ubuntu-latest x64 | ✅ 99/99 | GitHub Actions (Node 20 / 22) |

The Windows row was added on 2026-11-25, when CI ran `ubuntu-latest` only and most
users were on Windows. This plugin's 99 cases passed on Windows on the first run, but the same
exercise found two Windows-only test failures in `dsh-compaction-policy-engine` — so
all three repositories got a `windows-latest` CI job instead of relying on luck.

> Only platforms the suite has actually run on are listed. Absence here does not
> mean "unsupported" — it means nobody has verified it yet. If you ran the suite
> somewhere else, a PR adding the row is welcome.

## End-to-end self-check

Unit tests cannot tell you what *the package installed on your machine* does once a real
`dsh` loads it and a real HTTP fault arrives. The repository therefore carries an
end-to-end layer:

```bash
npm run test:e2e      # same as e2e/run.sh
```

It starts an **isolated `DSH_HOME`**, builds a temporary profile, installs this package
from npm, and points two **fake providers** at `127.0.0.1` — no real API calls. Their
behaviour is scripted per run (healthy / 500 / gateway-wrapped 400 / empty / malformed
tool call …).

Assertions do not ask "was there an error"; they ask **who was called, how many times, and
with what budget**. See [e2e/README.md](e2e/README.md) for the scenario list.

> The acceptance rule for this layer is in that README: a new scenario must **go red on
> the old version**. A test that is always green proves nothing.

## Compatibility and migration

- DSH `0.2.1-rc.x` / `0.2.2-rc.x` (`engines.dsh` is `>=0.2.1-0 <0.3.0-0`), Node.js 20+.
- **Renamed from `dsh-llm-fallback` in 0.5.0.** The profile entry id remains `llm-fallback`,
  so settings and existing patches keep working; update the `name:` field to
  `@magic6/dsh-llm-resilience`.
- The default breaker state file moved to
  `$DSH_HOME/storages/llm-resilience/state.json`. Set `stateFile` explicitly if you want to
  keep using an older breaker file.
- Replay envelopes from the old package name still unwrap (`dsh-llm-fallback` is accepted as
  a legacy kind).

## Reporting a problem

Open an issue — no need to work out first whether it is your configuration:

- 🐞 **[Bug report](https://github.com/T-splines/dsh-llm-resilience/issues/new?template=bug_report.yml)**
  — wrong behaviour, a crash, a chain that should have fallen back and did not, a
  breaker that never recovers.
- ❓ **[Config question](https://github.com/T-splines/dsh-llm-resilience/issues/new?template=config_question.yml)**
  — it runs, but does not do what you configured.

Four details usually decide the case, so include them if you can:

1. plugin version and DSH version;
2. operating system (Windows and macOS differ in path handling and file locking);
3. the exact `code` and `message` — not a paraphrase;
4. for a target the chain skipped, the breaker state file (`stateFile`).

Security issues: please do not open a public issue — use [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
