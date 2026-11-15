# Security policy

## Supported versions

The latest release on the `main` branch is supported. Pre-release versions are provided for
testing only.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
vulnerability reporting:

<https://github.com/T-splines/dsh-llm-resilience/security/advisories/new>

Include the affected version, a minimal reproduction and the impact you observed. You will
get an acknowledgement as soon as possible; please allow time for a fix and a coordinated
disclosure.

## Scope

This plugin runs inside the DSH host and routes requests to the providers you configure.
API keys are read from the host credential store or environment and are never written to
this repository or its logs. The breaker state file contains only counters and timestamps.
Vulnerabilities in DSH itself or in a third-party provider should be reported to that
project.
