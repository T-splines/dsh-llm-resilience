# Contributing

Thanks for taking a look. This project is test-first and deliberately has no runtime
dependencies.

## Development

Requirements: Node.js 20+.

```bash
git clone https://github.com/T-splines/dsh-llm-resilience.git
cd dsh-llm-resilience
npm install   # installs the public DSH peer packages used by the tests
npm test
```

The tests use `node --test` and local fakes; no DSH instance is required for the unit suite.
End-to-end smoke instructions are in [DESIGN.md](DESIGN.md).

## Pull requests

- Keep one logical change per commit. Use `feat:` / `fix:` / `test:` / `docs:` /
  `chore:` prefixes and explain *why* in the message.
- Add a regression test for every bug fix, especially for streaming, replay and breaker
  state. The tests pin contracts, not incidental implementation details.
- Do not add runtime dependencies without discussing it first.
- Update `CHANGELOG.md` for user-visible changes and keep the top version in sync with
  `package.json`.
