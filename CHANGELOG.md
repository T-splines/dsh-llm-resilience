# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

### Added

- A `plugin:llm-fallback` session record (`kind: "stop"`) whenever the chain
  deliberately stops instead of switching targets, carrying the failure code
  and the classification reason. The host mounts no console exporter for
  `ctx.logger`, so without this record "why did it not fail over" was
  unanswerable from logs.

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
