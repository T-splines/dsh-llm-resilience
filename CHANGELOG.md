# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-11-25

### Fixed

- **A chain that contains a model without thinking metadata no longer rejects every
  explicit reasoning effort.** The host validates `reasoningEffort` against the synthetic
  `fallback/auto` model before the request reaches this plugin. The synthetic model used to
  declare only the intersection of target capabilities, so a manually added model with no
  thinking config made `max` fail the whole turn with
  `provider "fallback" model "auto" does not support reasoning effort "max"`. **This was
  reported on 0.5.8 and reproduced unchanged on 0.5.10**; the GLM model in the report
  actually accepts `max`, but DSH had not discovered its `reasoningEfforts`. The synthetic
  model now always advertises the standard levels plus provider-specific levels found on
  targets, and each target decides what to send. A target whose metadata is missing gets
  its default behavior and a one-time warning naming the missing declaration — the chain
  no longer silently loses every level, and the misconfiguration is diagnosable.
- The adapter maps the requested level to the nearest level a target actually declares
  (`off=0`, `minimal=10`, `low=25`, `medium=50`, `high=75`, `xhigh=90`, `max=100`; ties go
  to the higher level). An unknown name falls back to the highest declared level, then the
  target default. A target with no reasoning metadata receives **no** effort parameter and
  uses its own default. A target whose metadata is stale can still reject the level at
  runtime; the adapter then reads the supported levels from the error, retries the nearest,
  and finally retries once without the parameter.

### Added

- Per-target `reasoningEffort` (default `auto`). `auto` follows the session selection;
  a concrete value pins that target and is still mapped to what the target supports.
- The settings card shows an effort dropdown per target, built from the model catalog's
  declared levels plus the standard levels. `auto` is the default.
- `lib/effort.js` with shared ranking/aliasing/mapping helpers and `test/effort.test.js`.
- Session records (`plugin:llm-fallback`, `kind: "effort"`) when a level is mapped,
  omitted, or rejected-and-retried, so a mismatch is diagnosable. A target that declares
  no reasoning support also logs a one-time warning naming the likely fix
  (`reasoningEfforts` / `modelOverrides.reasoningEfforts` in the provider profile) instead
  of silently dropping the requested level.
- Two end-to-end scenarios: `effort-map` (session `max`, target declares only low/high,
  target receives `high`) and `effort-omit` (fallback to a target with no thinking metadata,
  which receives no effort parameter). `0.5.10` fails both with the exact reported error;
  `0.6.0` passes all 12 scenarios on DSH 0.2.2-rc.5 and runs the effort scenarios on
  DSH 0.2.1-rc.5.

### Documentation

- README (both languages) and `DESIGN.md` document the validation-before-dispatch problem,
  the 0–100 scale, the fallback order, and the settings UI.

## [0.5.10] - 2026-11-25

### Added

- `e2e/run.sh drop-mid-tool` — a tool call is cut off mid-`arguments`. Tool-call chunks
  are held until `block-end`, so the host must never see the half-built call; the run
  should fall back transparently. This closes the last "tool-call retry specifics" gap
  listed in `DESIGN.md` §11.

Ten scenarios now; `0.5.5` fails 2 of them, `0.5.10` passes all 10.

## [0.5.9] - 2026-11-25

### Added

- Two more e2e scenarios, and a corrected one:
  - `probe-refail` — a probe that fails must **re-lock** the target, not let it back in;
  - `drop` — content delivered, then the stream dies. The turn is replayed by the host and
    the user sees **exactly one** copy of the content.
- `exhausted` now asserts the error code (`FALLBACK_EXHAUSTED`) and that the last real
  failure survives in the message, not merely that the run failed.

### Fixed

- The `drop` scenario was asserting the wrong thing. It expected "target 2 must never be
  contacted", but step replay legitimately contacts it: the plugin refuses to append a
  second target's output after content was already delivered, hands the failure to the
  host, and the replay skips the failed target. The assertion now checks what a user
  actually experiences — one coherent answer, no half-finished prefix — instead of an
  implementation detail. **A wrong assertion is worse than no test**: it reads as verified.

  This also required fixing the fake server: `drop` used to send `[DONE]` before closing,
  which pi-ai treats as a clean end, so the scenario never reached the branch it named.

## [0.5.8] - 2026-11-25

### Added

- **An end-to-end layer (`e2e/`, `npm run test:e2e`).** A real `dsh` is started in an
  isolated `DSH_HOME` with this package installed, against two scripted fake providers on
  `127.0.0.1`. Assertions check *who was called, how many times and with what budget* —
  not merely that the process exited cleanly.

  This exists because of a specific mistake: on 2026-11-24 the plugin appeared fine in
  production ("no more errors"), when in fact the session had been switched to call a
  provider directly and the chain was never entered. **A green run with no traffic proves
  nothing**, and unit tests cannot see these failures at all — their adapter is a fake.

  Seven scenarios: `baseline`, `upstream400`, `genuine400`, `transient500`, `exhausted`,
  `malformed`, `breaker` (four rounds covering the real `background: true` probe
  semantics). Verified as a regression net: **0.5.5 fails 2 of them** (the wrapper-400
  no-op and the `maxTokens: 1` probe), **0.5.8 passes all 7**. That comparison is now the
  acceptance rule for any new scenario — a test that is always green is not a test.

- CI runs the e2e suite on `ubuntu-latest` with a pinned `dsh`; no API keys are involved.

### Documentation

- README (both languages) gained an "end-to-end self-check" section; `DESIGN.md` now
  separates scenarios that exist from scenarios that are still gaps, instead of claiming
  the whole list.

## [0.5.7] - 2026-11-25

### Documentation

- README (both languages) now carries a **tested platforms** table — only
  environments where the suite was actually run are listed — and a **reporting a
  problem** section pointing at the new issue templates.
- `.github/ISSUE_TEMPLATE/` added: `bug_report.yml` (asks for the version, platform,
  verbatim `code`/`message` and the breaker state file) and `config_question.yml`.

## [0.5.6] - 2026-11-24

### Fixed

- **Gateway-wrapped upstream 4xx is now a target-level fault, not a request
  error.** A gateway can return `400 {"code":"upstream_error"}` for a request
  whose body is fine; pi-ai sees the literal `400` and classifies it as
  `INVALID_REQUEST`, which the chain treated as `fail` — so the whole fallback
  chain became a no-op at the first target. Such failures now fall back to the
  next target. Genuine request errors (invalid tool schema, oversized payload,
  missing field) carry none of those markers and still fail fast. Explicit
  `codeActions.INVALID_REQUEST` overrides still win.

- **The health probe can now actually succeed.** It defaulted to `maxTokens: 1`, which a
  reasoning model spends entirely on thinking: the response comes back empty, pi-ai reports
  `EMPTY_RESPONSE`, and the probe declares a healthy target broken. Measured in stream
  mode: `1` and `16` → `finish_reason=length` with no content; `64` → content (non-stream
  DeepSeek needs ~256). The default is now `256`. Without this the recovery path was dead
  code: the target re-locked every `lockMs`, forever.
- **An inconclusive probe no longer re-locks a healthy target.** Even with a sane budget a
  probe can fail for reasons that describe the probe, not the target (`EMPTY_RESPONSE`,
  `INVALID_REQUEST` from providers that reject degenerate requests). Treating those as
  failure means the recovery check can never succeed. They are now *inconclusive*: the lock
  is released (same path as a successful probe, tombstone included) and real traffic
  decides. Gateway-wrapped upstream faults stay conclusive — real requests hit them too.

### Added

- A `plugin:llm-fallback` session record (`kind: "stop"`) whenever the chain
  deliberately stops instead of switching targets, carrying the failure code
  and the classification reason. The host mounts no console exporter for
  `ctx.logger`, so without this record "why did it not fail over" was
  unanswerable from logs.
- `kind: "probe"` records now distinguish `phase: "failed"` from
  `phase: "inconclusive"`, so "the target came back but our probe was too dumb to see
  it" is visible instead of looking like another failure.

### Changed

- **Releases now go through npm OIDC trusted publishing**, not a local token.
  `.github/workflows/publish.yml` publishes on a `vX.Y.Z` tag and refuses to run
  when the tag, `package.json` and the CHANGELOG top section disagree.
  CONTRIBUTING documents the one-time trusted-publisher setup.
## [0.5.5] - 2026-11-22

### Fixed

- Host compatibility range now includes DSH `0.2.1-rc.x` as well as `0.2.2-rc.x`.
  DSH 0.2.1 rejects `engines.dsh >=0.2.2-0`, so the previous manifest blocked
  installation even though the plugin runs on 0.2.1.
- README: state the supported DSH versions.

## [0.5.4] - 2026-11-16

### Fixed

- Bundle entry and client module identities now use the scoped npm package name,
  so the installed package resolves at runtime and its settings page pairs with
  the correct plugin row.
- README: profile override examples use the scoped package name.

## [0.5.3] - 2026-11-16

### Changed

- npm package renamed to `@magic6/dsh-llm-resilience`; npm requires a scoped
  package for the first automated publish.
- README: update the npm installation command.

## [0.5.2] - 2026-11-16

### Added

- npm distribution: install with `dsh plugin --profile web add dsh-llm-resilience`.

### Changed

- README: document npm installation and use absolute links for the language switch.

## [0.5.1] - 2026-11-16

### Changed

- README: add a visible English / Simplified Chinese language switch.

## [0.5.0] - 2026-11-16

First public release. The plugin was built from a concrete failure mode observed in the
author's deployment of **OpenDesign Go** (intermittent tool-call stream and API connection
failures); it is an independent project and is not affiliated with OpenDesign.

### Added

- Synthetic provider route (`fallback/auto`) with an ordered chain of real provider/model
  targets.
- Per-target retry budget, configurable multiplier (including 1.5), jitter and delay cap.
- Error classification: entitlement/membership/quota 500 → fallback; transient errors →
  retry; invalid requests → fail; `IMAGE_OFFLOAD_REQUIRED` and `CONTEXT_WINDOW_EXCEEDED`
  pass through unchanged.
- Streaming-safe tool-call buffering; malformed model-generated tool calls can be retried
  without duplicate output.
- Step-replay continuation with rotation across the whole chain; chain-tail failures are
  retried in place.
- Persistent circuit breaker per `provider + model`, half-open probes (foreground and
  background), multi-process state file with tombstones.
- Global deadline and attempt cap.
- Session observability and a settings-page chain editor with live breaker state.
- 90 `node --test` cases and isolated DSH end-to-end smoke coverage.

### Changed

- Package and repository renamed from `dsh-llm-fallback` to `dsh-llm-resilience`. The
  profile entry id remains `llm-fallback` for settings compatibility.
- Default breaker state file is now
  `$DSH_HOME/storages/llm-resilience/state.json`. Set `stateFile` explicitly to reuse an
  older breaker file.
- Replay envelopes written under the old package name are still accepted.
- README and DESIGN rewritten for the public release; added a Chinese README, security
  policy, contribution guide and CI.

Earlier internal versions are preserved in the private development history.
