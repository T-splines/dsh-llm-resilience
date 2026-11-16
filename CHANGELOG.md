# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
